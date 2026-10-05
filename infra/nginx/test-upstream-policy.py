"""Exercise the real proxy config against isolated mock Gateways; no host ports or DB."""
import argparse
from pathlib import Path
import re
import subprocess
import tempfile
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--image', default='nginx:alpine')
parser.add_argument('--config', type=Path, default=Path(__file__).resolve().parent / 'nginx.conf')
args = parser.parse_args()
source = args.config
config = source.read_text().replace(
    'server api-gateway:3000 resolve;',
    'server 127.0.0.1:8091; server 127.0.0.1:8092;',
)
for service, port in [('conversation-service', 3005), ('call-service', 3007), ('payment-service', 3006)]:
    config = config.replace(f'server {service}:{port} resolve;', f'server 127.0.0.1:{port};')
mock = '''
    server {
        listen PORT;
        location = /dependency-down { return 503; }
        location = /auth/socket-token { return 401; }
        location / { return 200; }
    }
'''
config = config.rstrip()[:-1] + mock.replace('PORT', '8091') + mock.replace('PORT', '8092') + '\n}\n'
name = 'velora-nginx-policy-test-' + uuid.uuid4().hex[:8]

def docker(*commands):
    return subprocess.run(['docker', *commands], text=True, capture_output=True, check=True).stdout

try:
    with tempfile.TemporaryDirectory(prefix='velora-nginx-policy-') as directory:
        path = Path(directory) / 'nginx.conf'
        path.write_text(config)
        docker('run', '-d', '--name', name, '--network', 'none', '--entrypoint', 'nginx', '--mount',
               f'type=bind,src={path},dst=/etc/nginx/nginx.conf,readonly', args.image, '-g', 'daemon off;')
        docker('exec', name, 'nginx', '-t')
        docker('exec', name, 'sh', '-c',
               'for n in 1 2 3 4 5; do wget -q -O /dev/null -T 1 http://127.0.0.1/ && exit 0; sleep 1; done; exit 1')
        for i in range(6):
            endpoint, expected = ('dependency-down', 503) if i % 2 == 0 else ('auth/socket-token', 401)
            result = subprocess.run(['docker', 'exec', name, 'wget', '-S', '-O', '/dev/null',
                                     '-T', '3', f'http://127.0.0.1/{endpoint}'],
                                    text=True, capture_output=True)
            codes = re.findall(r'HTTP/1\.[01] (\d+)', result.stderr + result.stdout)
            assert codes and int(codes[-1]) == expected, f'{endpoint}: expected {expected}, observed {codes}; {result.stderr}'
        logs = docker('logs', name)
        assert 'no live upstreams' not in logs, 'Application 503 quarantined healthy Gateways'
        print('PASS: repeated dependency 503 preserves both Gateways and protected-route 401')
except Exception as error:
    if isinstance(error, subprocess.CalledProcessError):
        print(error.stderr)
    logs = subprocess.run(['docker', 'logs', name], text=True, capture_output=True)
    print(logs.stdout + logs.stderr)
    raise
finally:
    subprocess.run(['docker', 'rm', '-f', name], capture_output=True, check=False)
