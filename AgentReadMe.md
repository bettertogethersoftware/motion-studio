# Tool Available to AI Agents
You may use the following tools and folders to help create your videos

The Motion Studio main folder, when you interact with Motion Studio MCP, your data is on

motion-studio\data\

The model: workspace → film → scene

<dataDir>/workspaces/<workspace>/            one per AI; the human sees them all
  library/                                   shared assets the human provides
  films/<film>/
    film.json  assets/  out/                 the film owns its audio and output
    scenes/<scene>/                          one composition — the render unit

if you want to check users global assets
e.g.
motion-studio\data\workspaces\default\library
if you wannt to check motion studio render output after it is done
e.g.
motion-studio\data\workspaces\default\films\{film-name}\scenes\{scenes-name}\out

if you wannt to direct editing or custom editing of composition.html and related assets
e.g.
motion-studio\data\workspaces\default\films\{film-name}\scenes\{scenes-name}\



# latest Skill
motion-studio\docs\SKILL.md

# Motion Studion Direct Access Folder
motion-studio\data\workspaces\default\films
motion-studio\data\workspaces\default\
motion-studio\data\workspaces\default\library

# whisper
motion-studio\whisper-bin-x64\Release\whisper-cli.exe

# ffmpeg
motion-studio\motion-studio\ffmpeg-8.1.2-full_build\bin\ffmpeg.exe
motion-studio\motion-studio\ffmpeg-8.1.2-full_build\bin\ffplay.exe
motion-studio\motion-studio\ffmpeg-8.1.2-full_build\bin\ffprobe.exe

Bugs: the bundled ffmpeg-8.1.2-full_build segfaults on the drawtext filter (no fontconfig) — only affects scratch tooling.

# When you are working with sfx
Don't use synthesize_sfx cue types chime and shimmer (plus whoosh/thud)
