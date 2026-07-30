import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
const root = process.cwd();
const transport = new StdioClientTransport({command:'node',args:[path.join(root,'engine/src/mcp/server.js')],env:{...process.env,MOTION_STUDIO_WORKSPACE:'codex',MOTION_STUDIO_FFMPEG:path.resolve(root,'..','ffmpeg-8.1.2-full_build/bin/ffmpeg.exe')}});
const c = new Client({name:'list-ja',version:'1.0.0'}); await c.connect(transport);
const r = await c.callTool({name:'list_voices',arguments:{vendor:'system',}}); console.log(JSON.stringify(r)); await transport.close();
