// Serializes this studio's GPU post-production jobs. ComfyUI owns its inference queue.
let pending=Promise.resolve();
export function withGpuLease(operation){const result=pending.then(operation);pending=result.catch(()=>{});return result;}
