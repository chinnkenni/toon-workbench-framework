import json, os, platform, subprocess, time, shutil, urllib.request

def run(args):
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=5)
        return p.stdout.strip()
    except Exception:
        return ''

def cpu():
    with open('/proc/stat') as f:
        values = list(map(int, f.readline().split()[1:]))
    return sum(values[:8]), values[3] + values[4]

before = cpu()
time.sleep(0.25)
after = cpu()
total = after[0] - before[0]
mem = {}
with open('/proc/meminfo') as f:
    for line in f:
        key, val = line.split(':', 1)
        mem[key] = int(val.strip().split()[0]) * 1024
disk = shutil.disk_usage('/')
gpu = None
raw = run(['nvidia-smi', '--query-gpu=name,temperature.gpu,utilization.gpu,power.draw,driver_version', '--format=csv,noheader,nounits'])
if raw:
    fields = [s.strip() for s in raw.splitlines()[0].split(',')]
    def number(s):
        try: return float(s)
        except ValueError: return None
    if len(fields) == 5:
        gpu = dict(name=fields[0], temperature=number(fields[1]), utilization=number(fields[2]), power=number(fields[3]), driver=fields[4])
with open('/proc/uptime') as f: uptime = float(f.read().split()[0])
os_name = platform.system()
try:
    with open('/etc/os-release') as f:
        for line in f:
            if line.startswith('PRETTY_NAME='): os_name = line.split('=',1)[1].strip().strip('"')
except OSError: pass
checks = {
    'sshBoot': run(['systemctl', 'is-enabled', 'ssh']) == 'enabled',
    'noSleep': run(['systemctl', 'is-enabled', 'suspend.target']) == 'masked',
    'linger': run(['loginctl', 'show-user', str(os.getuid()), '-p', 'Linger', '--value']) == 'yes',
    'sudo': subprocess.run(['sudo', '-n', 'true'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0,
    'docker': bool(run(['docker', 'info', '--format', '{{.ServerVersion}}'])),
}
services = {}
for name, url in [('comfyui','http://127.0.0.1:8188/system_stats')]:
    try:
        with urllib.request.urlopen(url, timeout=0.7) as response: services[name] = response.status == 200
    except Exception: services[name] = False
deployment = None
try:
    with open(os.path.expanduser('~/ai-stack/deployment-status.json')) as f: deployment = json.loads(f.read(65536))
except Exception: pass
smoke = None
try:
    with open(os.path.expanduser('~/ai-stack/smoke-status.json')) as f: smoke = json.loads(f.read(65536))
except Exception: pass
provision = None
try:
    with open(os.path.expanduser('~/ai-stack/provision-status.json')) as f: provision = json.loads(f.read(65536))
except Exception: pass
net = {}
primary_ip = None
try:
    routes = json.loads(run(['ip','-j','route','get','1.1.1.1']))
    primary_ip = routes[0].get('prefsrc') if routes else None
except Exception: pass
with open('/proc/net/dev') as f:
    for line in f.readlines()[2:]:
        name, values = line.split(':', 1)
        if name.strip() == 'lo': continue
        values = values.split()
        net[name.strip()] = {'rx': int(values[0]), 'tx': int(values[8])}
print(json.dumps(dict(hostname=platform.node(), architecture=platform.machine(), os=os_name,
    cpu=round(100*(1-(after[1]-before[1])/total),1) if total else 0, cores=os.cpu_count(),
    memory=dict(total=mem['MemTotal'], used=mem['MemTotal']-mem.get('MemAvailable',mem['MemFree'])),
    disk=dict(total=disk.total,used=disk.used), gpu=gpu, uptime=uptime, checks=checks, network=net,
    load=os.getloadavg(), services=services, deployment=deployment, provision=provision, smoke=smoke, primaryIp=primary_ip, sampledAt=time.time())))
