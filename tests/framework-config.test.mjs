import test from 'node:test';
import assert from 'node:assert/strict';
import {readFrameworkGpuConfig} from '../framework-config.mjs';
test('missing remote configuration stays unavailable without a default machine',()=>{assert.equal(readFrameworkGpuConfig({required:false,env:{}}),null);assert.throws(()=>readFrameworkGpuConfig({env:{}}),{status:503});});
test('SSH configuration rejects option injection and relative key paths',()=>{for(const env of [{TOON_GPU_HOST:'-bad',TOON_GPU_USER:'artist',TOON_GPU_SSH_KEY:'/keys/demo'},{TOON_GPU_HOST:'gpu.example.invalid',TOON_GPU_USER:'artist',TOON_GPU_SSH_KEY:'relative'}])assert.throws(()=>readFrameworkGpuConfig({env}),{status:503});});
