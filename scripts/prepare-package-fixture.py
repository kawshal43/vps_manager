"""Seed package-removal tests only on the named, loopback-only disposable VM."""
import io
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
BASE = (ROOT / '.test-data' / 'ubuntu').resolve()
assert BASE.is_relative_to(ROOT.resolve() / '.test-data')
sys.path.insert(0, str(ROOT / '.test-data' / 'python'))
import pycdlib

VBOX = r'C:\Program Files\Oracle\VirtualBox\VBoxManage.exe'
VM = 'VPS-Manager-Acceptance'
def vbox(*args):
    return subprocess.check_output([VBOX, *args], text=True, stderr=subprocess.STDOUT)

config = json.loads((BASE / 'connection.json').read_text())
assert config['host'] == '127.0.0.1' and config['port'] == 22222 and config['username'] == 'vpstest'
info = vbox('showvminfo', VM, '--machinereadable')
assert 'VMState="poweroff"' in info, 'Stop the disposable VM before changing its seed.'
cfg_line = next(line for line in info.splitlines() if line.startswith('CfgFile='))
cfg_file = Path(json.loads(cfg_line.split('=', 1)[1])).resolve()
assert cfg_file.parent == BASE / VM, 'The named VM is not in the fixture workspace.'
sudo = 'vpstest ALL=(root) NOPASSWD: /usr/bin/apt-get *, /usr/bin/systemctl --no-ask-password stop -- vps-manager-test.service, /usr/bin/systemctl --no-ask-password disable -- vps-manager-test.service\n'
cloud = {
    'hostname': 'vps-manager-test',
    'ssh_deletekeys': False,
    'ssh_keys': {'ed25519_private': (BASE / 'host_key').read_text(), 'ed25519_public': (BASE / 'host_key.pub').read_text().strip()},
    'write_files': [{'path': '/etc/sudoers.d/vps-manager-package-fixture', 'permissions': '0440', 'content': sudo}],
    'runcmd': [['sh', '-c', 'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y hello && touch /home/vpstest/.vps-package-fixture-ready']],
}
entries = {'user-data': '#cloud-config\n' + json.dumps(cloud), 'meta-data': 'instance-id: vps-manager-package-fixture-1\nlocal-hostname: vps-manager-test\n', 'network-config': 'version: 2\nethernets:\n  eth0:\n    match:\n      name: "en*"\n    dhcp4: true\n'}
iso = pycdlib.PyCdlib(); iso.new(interchange_level=3, joliet=3, vol_ident='cidata')
for index, (name, content) in enumerate(entries.items()):
    data = content.encode(); iso.add_fp(io.BytesIO(data), len(data), iso_path=f'/FILE{index}.;1', joliet_path='/' + name)
seed = BASE / 'package-seed.iso'; iso.write(str(seed)); iso.close()
vbox('storageattach', VM, '--storagectl', 'SATA', '--port', '1', '--device', '0', '--type', 'dvddrive', '--medium', str(seed))
vbox('startvm', VM, '--type', 'headless')
print('Started only the disposable package fixture. Wait for cloud-init readiness before removal tests.')
