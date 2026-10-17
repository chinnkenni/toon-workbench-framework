import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const blocked=()=>{throw new Error('Offline unit tests cannot access network or launch processes');};
globalThis.fetch=blocked;
for(const module of [http,https]){module.request=blocked;module.get=blocked;}
net.connect=blocked;net.createConnection=blocked;net.Socket.prototype.connect=blocked;net.Server.prototype.listen=blocked;
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])childProcess[name]=blocked;
syncBuiltinESMExports();
