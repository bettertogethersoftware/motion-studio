// MotionStudioMidi — the MIDI-authoring half of Motion Studio's music pipeline:
//
//   LLM (note spec JSON) -> MotionStudioMidi (DryWetMIDI) -> song.mid
//                        -> FluidSynth + SoundFont -> WAV -> config.audio track
//
// CLI:
//   MotionStudioMidi.exe --spec-file <utf8 json> --out <song.mid>
//
//   success: exit 0, writes the MIDI, prints one JSON line:
//     { "ok":true, "tracks", "notes", "bpm", "durationSeconds", "outPath" }
//   failure: non-zero exit, { "ok":false, "error":"...", "code":"..." }
//
// Spec JSON:
//   { "bpm": 120,
//     "tracks": [ { "program": 0, "drums": false,
//       "notes": [ { "pitch": 60, "start": 0, "duration": 1, "velocity": 96 } ] } ] }
//   pitch = MIDI note 0..127; start/duration in beats (quarter notes); velocity 1..127.
//   drums:true routes the track to channel 10 (GM percussion); program is ignored.

using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Melanchall.DryWetMidi.Common;
using Melanchall.DryWetMidi.Core;
using Melanchall.DryWetMidi.Interaction;

Console.OutputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);

const short TPQ = 480; // ticks per quarter note

string? Opt(string name)
{
    int i = Array.IndexOf(args, name);
    return (i >= 0 && i + 1 < args.Length) ? args[i + 1] : null;
}
void Emit(object value) => Console.WriteLine(JsonSerializer.Serialize(value));
int Fail(string code, string error, int exitCode) { Emit(new { ok = false, code, error }); return exitCode; }

try
{
    string? specFile = Opt("--spec-file");
    string? outMid = Opt("--out");
    if (string.IsNullOrEmpty(specFile) || string.IsNullOrEmpty(outMid))
        return Fail("invalid_music_spec", "--spec-file and --out are both required", 2);
    if (!File.Exists(specFile))
        return Fail("invalid_music_spec", $"--spec-file not found: {specFile}", 2);

    Spec? spec;
    try { spec = JsonSerializer.Deserialize<Spec>(File.ReadAllText(specFile, Encoding.UTF8), new JsonSerializerOptions { PropertyNameCaseInsensitive = true }); }
    catch (Exception e) { return Fail("invalid_music_spec", "spec is not valid JSON: " + e.Message, 2); }
    if (spec?.Tracks == null || spec.Tracks.Count == 0)
        return Fail("invalid_music_spec", "spec must contain at least one track", 2);

    double bpm = spec.Bpm > 0 ? spec.Bpm : 120;
    long usPerQuarter = (long)Math.Round(60_000_000.0 / bpm);

    var midi = new MidiFile { TimeDivision = new TicksPerQuarterNoteTimeDivision(TPQ) };
    int totalNotes = 0;
    long maxEndTicks = 0;
    int melodicChannel = 0;

    for (int ti = 0; ti < spec.Tracks.Count; ti++)
    {
        var t = spec.Tracks[ti];
        var objs = new List<ITimedObject>();
        if (ti == 0) objs.Add(new TimedEvent(new SetTempoEvent(usPerQuarter), 0));

        FourBitNumber ch;
        if (t.Drums) { ch = (FourBitNumber)9; }
        else { if (melodicChannel == 9) melodicChannel++; ch = (FourBitNumber)Math.Min(melodicChannel, 15); melodicChannel++; }

        if (!t.Drums)
            objs.Add(new TimedEvent(new ProgramChangeEvent((SevenBitNumber)Math.Clamp(t.Program, 0, 127)) { Channel = ch }, 0));

        foreach (var n in t.Notes ?? new List<NoteSpec>())
        {
            long start = (long)Math.Round(n.Start * TPQ);
            if (start < 0) start = 0;
            long len = (long)Math.Max(1, Math.Round(n.Duration * TPQ));
            int vel = n.Velocity > 0 ? Math.Clamp(n.Velocity, 1, 127) : 96;
            objs.Add(new Note((SevenBitNumber)Math.Clamp(n.Pitch, 0, 127), len, start) { Velocity = (SevenBitNumber)vel, Channel = ch });
            totalNotes++;
            maxEndTicks = Math.Max(maxEndTicks, start + len);
        }

        var chunk = new TrackChunk();
        chunk.AddObjects(objs);
        midi.Chunks.Add(chunk);
    }

    if (totalNotes == 0) return Fail("invalid_music_spec", "spec contains no notes", 2);

    string fullOut = Path.GetFullPath(outMid);
    string? dir = Path.GetDirectoryName(fullOut);
    if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
    midi.Write(fullOut, overwriteFile: true);

    double seconds = maxEndTicks / (double)TPQ * (60.0 / bpm);
    Emit(new { ok = true, tracks = spec.Tracks.Count, notes = totalNotes, bpm, durationSeconds = Math.Round(seconds, 3), outPath = fullOut });
    return 0;
}
catch (Exception ex)
{
    Console.Error.WriteLine(ex);
    return Fail("music_failed", ex.Message, 1);
}

class Spec { public double Bpm { get; set; } public List<Track>? Tracks { get; set; } }
class Track { public int Program { get; set; } public bool Drums { get; set; } public List<NoteSpec>? Notes { get; set; } }
class NoteSpec { public int Pitch { get; set; } public double Start { get; set; } public double Duration { get; set; } public int Velocity { get; set; } }
