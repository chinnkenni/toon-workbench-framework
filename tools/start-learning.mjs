import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createStudioServer} from '../studio-server.mjs';
const rootDir=fileURLToPath(new URL('../',import.meta.url));
const server=await createStudioServer({rootDir,dataDir:join(rootDir,'data'),port:18990,monitorUrl:'http://127.0.0.1:18987',publishingAdapters:{}});
console.log('Learning workbench: '+server.origin+' (empty local data; external engines require separate setup)');
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await server.close();process.exit(0);});
