// MotionStudioTts — the external Windows speech helper Motion Studio spawns for
// text-to-speech narration. Honors the CLI contract in docs/tts-setup.md:
//
//   MotionStudioTts.exe --text-file <utf8 path> --out <.wav path> \
//                       --voice "<name>" [--rate N] [--volume N] [--engine winrt|sapi]
//   MotionStudioTts.exe --list-voices [--engine winrt|sapi]
//
//   success: exit 0, PCM WAV written to --out, one JSON line on stdout:
//     { "ok":true, "voice", "engine", "durationSeconds", "sampleRate",
//       "channels", "bytes", "outPath" }
//     (--list-voices prints a JSON array of installed voice names instead)
//   failure: non-zero exit, { "ok":false, "error":"...", "code":"..." }
//
// Two backends, both from the Windows runtime, no NuGet:
//   * WinRT (default): Windows.Media.SpeechSynthesis — the OneCore "mobile"
//     voices (more voices, including male). Higher quality than the classic
//     SAPI5 "Desktop" voices.
//   * SAPI5 (--engine sapi, or automatic fallback): SAPI.SpVoice/SpFileStream
//     via late-bound COM. Used when WinRT is unavailable.
//
// The engine re-derives the authoritative duration from the WAV header, but we
// report an accurate value too by parsing the file we just wrote.

using System.Globalization;
using System.Text;
using System.Text.Json;
using Windows.Media.SpeechSynthesis;
using Windows.Storage.Streams;

Console.OutputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);

string? Opt(string name)
{
    int i = Array.IndexOf(args, name);
    return (i >= 0 && i + 1 < args.Length) ? args[i + 1] : null;
}
int? OptInt(string name) =>
    int.TryParse(Opt(name), NumberStyles.Integer, CultureInfo.InvariantCulture, out int v) ? v : null;
void Emit(object value) => Console.WriteLine(JsonSerializer.Serialize(value));
int Fail(string code, string error, int exitCode) { Emit(new { ok = false, code, error }); return exitCode; }

string? engineArg = Opt("--engine")?.ToLowerInvariant();
bool forceSapi = engineArg == "sapi";

try
{
    // ---- list voices -------------------------------------------------------
    if (Array.IndexOf(args, "--list-voices") >= 0)
    {
        if (!forceSapi)
        {
            try { Emit(WinrtVoices()); return 0; }
            catch { /* fall through to SAPI */ }
        }
        Emit(SapiVoices());
        return 0;
    }

    // ---- synthesize --------------------------------------------------------
    string? textFile = Opt("--text-file");
    string? outPath = Opt("--out");
    if (string.IsNullOrEmpty(textFile) || string.IsNullOrEmpty(outPath))
        return Fail("tts_failed", "--text-file and --out are both required", 2);
    if (!File.Exists(textFile))
        return Fail("tts_failed", $"--text-file not found: {textFile}", 2);

    string text = File.ReadAllText(textFile, Encoding.UTF8);
    if (string.IsNullOrWhiteSpace(text))
        return Fail("tts_failed", "narration text is empty", 2);

    string fullOut = Path.GetFullPath(outPath);
    string? dir = Path.GetDirectoryName(fullOut);
    if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

    string? voice = Opt("--voice");
    int? rate = OptInt("--rate");
    int? volume = OptInt("--volume");

    string usedEngine;
    string usedVoice;
    if (forceSapi)
    {
        usedVoice = SapiSynth(text, voice, fullOut, rate, volume);
        usedEngine = "sapi";
    }
    else
    {
        try
        {
            usedVoice = await WinrtSynth(text, voice, fullOut, rate, volume);
            usedEngine = "winrt";
        }
        catch (VoiceNotFoundException) { throw; } // a bad voice name is a real error, don't silently fall back
        catch
        {
            usedVoice = SapiSynth(text, voice, fullOut, rate, volume);
            usedEngine = "sapi";
        }
    }

    var info = ReadWavInfo(fullOut);
    Emit(new
    {
        ok = true,
        voice = usedVoice,
        engine = usedEngine,
        durationSeconds = info.duration,
        sampleRate = info.sampleRate,
        channels = info.channels,
        bytes = info.bytes,
        outPath = fullOut,
    });
    return 0;
}
catch (VoiceNotFoundException ex)
{
    return Fail("unsupported_voice", ex.Message, 3);
}
catch (Exception ex)
{
    Console.Error.WriteLine(ex); // full stack → engine captures as stderr tail
    return Fail("tts_failed", ex.Message, 1);
}

/* ---------------------------- WinRT backend ---------------------------- */

static string[] WinrtVoices() =>
    SpeechSynthesizer.AllVoices.Select(v => v.DisplayName).ToArray();

static async Task<string> WinrtSynth(string text, string? voice, string outPath, int? rate, int? volume)
{
    using var synth = new SpeechSynthesizer();
    var all = SpeechSynthesizer.AllVoices;

    VoiceInformation? vi;
    if (!string.IsNullOrEmpty(voice))
    {
        vi = all.FirstOrDefault(v => v.DisplayName == voice);
        if (vi == null) throw new VoiceNotFoundException(voice, all.Select(v => v.DisplayName));
    }
    else
    {
        vi = synth.Voice ?? all.FirstOrDefault();
        if (vi == null) throw new InvalidOperationException("no WinRT voices installed");
    }
    synth.Voice = vi;

    if (rate.HasValue)   synth.Options.SpeakingRate = Math.Clamp(1.0 + rate.Value * 0.08, 0.5, 3.0);
    if (volume.HasValue) synth.Options.AudioVolume = Math.Clamp(volume.Value / 100.0, 0.0, 1.0);

    using SpeechSynthesisStream stream = await synth.SynthesizeTextToStreamAsync(text);
    uint size = (uint)stream.Size;
    using var input = stream.GetInputStreamAt(0);
    using var reader = new DataReader(input);
    await reader.LoadAsync(size);
    var buf = new byte[size];
    reader.ReadBytes(buf);
    File.WriteAllBytes(outPath, buf);
    return vi.DisplayName;
}

/* ---------------------------- SAPI5 backend ---------------------------- */

static dynamic CreateCom(string progId)
{
    Type t = Type.GetTypeFromProgID(progId)
        ?? throw new InvalidOperationException($"COM component {progId} is not registered (SAPI missing?)");
    return Activator.CreateInstance(t)
        ?? throw new InvalidOperationException($"could not create {progId}");
}

static string[] SapiVoices()
{
    dynamic sapi = CreateCom("SAPI.SpVoice");
    dynamic tokens = sapi.GetVoices(string.Empty, string.Empty);
    int count = (int)tokens.Count;
    var names = new string[count];
    for (int i = 0; i < count; i++) names[i] = (string)tokens.Item(i).GetDescription(0);
    return names;
}

static string SapiSynth(string text, string? voice, string outPath, int? rate, int? volume)
{
    const int SSFMCreateForWrite = 3, SVSFDefault = 0, SAFT22kHz16BitMono = 22;
    dynamic sapi = CreateCom("SAPI.SpVoice");
    dynamic tokens = sapi.GetVoices(string.Empty, string.Empty);
    int count = (int)tokens.Count;
    if (count == 0) throw new InvalidOperationException("no speech voices are installed on this machine");

    var available = new List<string>(count);
    for (int i = 0; i < count; i++) available.Add((string)tokens.Item(i).GetDescription(0));

    int idx = 0;
    if (!string.IsNullOrEmpty(voice))
    {
        idx = available.IndexOf(voice);
        if (idx < 0) throw new VoiceNotFoundException(voice, available);
    }
    // Always select a concrete voice; the SAPI *default* NREs on some machines.
    sapi.Voice = tokens.Item(idx);
    if (rate.HasValue) sapi.Rate = Math.Clamp(rate.Value, -10, 10);
    if (volume.HasValue) sapi.Volume = Math.Clamp(volume.Value, 0, 100);

    dynamic stream = CreateCom("SAPI.SpFileStream");
    stream.Format.Type = SAFT22kHz16BitMono;
    stream.Open(outPath, SSFMCreateForWrite, false);
    try
    {
        sapi.AudioOutputStream = stream;
        sapi.Speak(text, SVSFDefault);
    }
    finally
    {
        sapi.AudioOutputStream = null;
        stream.Close();
    }
    return available[idx];
}

/* ------------------------------ WAV info ------------------------------- */

static (double duration, int sampleRate, int channels, long bytes) ReadWavInfo(string path)
{
    byte[] b = File.ReadAllBytes(path);
    long bytes = b.LongLength;
    int sr = 0, ch = 0, byteRate = 0; long dataSize = 0;
    if (b.Length >= 12 && Encoding.ASCII.GetString(b, 0, 4) == "RIFF" && Encoding.ASCII.GetString(b, 8, 4) == "WAVE")
    {
        int off = 12;
        while (off + 8 <= b.Length)
        {
            string id = Encoding.ASCII.GetString(b, off, 4);
            uint sz = BitConverter.ToUInt32(b, off + 4);
            int body = off + 8;
            if (id == "fmt " && body + 16 <= b.Length)
            {
                ch = BitConverter.ToUInt16(b, body + 2);
                sr = (int)BitConverter.ToUInt32(b, body + 4);
                byteRate = (int)BitConverter.ToUInt32(b, body + 8);
            }
            else if (id == "data")
            {
                dataSize = Math.Min(sz, (uint)Math.Max(0, b.Length - body));
            }
            off = body + (int)sz + ((int)sz & 1);
        }
    }
    double dur = byteRate > 0 ? (double)dataSize / byteRate : 0;
    return (Math.Round(dur, 3), sr, ch, bytes);
}

/* ------------------------------------------------------------------------ */

class VoiceNotFoundException : Exception
{
    public VoiceNotFoundException(string voice, IEnumerable<string> available)
        : base($"no installed voice named \"{voice}\"; available: {string.Join(", ", available)}") { }
}
