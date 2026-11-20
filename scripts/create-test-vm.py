"""Provision only the disposable VPS-Manager-Acceptance VM (never existing VMs)."""
import hashlib
import io
import json
from pathlib import Path
import secrets
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / '.test-data' / 'ubuntu'
sys.path.insert(0, str(ROOT / '.test-data' / 'python'))
import pycdlib  # noqa: E402

VBOX = r'C:\Program Files\Oracle\VirtualBox\VBoxManage.exe'
VM = 'VPS-Manager-Acceptance'

def vbox(*args):
    return subprocess.check_output([VBOX, *args], text=True, stderr=subprocess.STDOUT)

def main():
    BASE.mkdir(parents=True, exist_ok=True)
    if (BASE / 'connection.json').exists():
        if 'VMState="running"' not in vbox('showvminfo', VM, '--machinereadable'):
            vbox('startvm', VM, '--type', 'headless')
        print('Disposable VM is configured and running; preserving its test credentials.')
        return
    disk = BASE / 'noble.vmdk'
    checksums = urllib.request.urlopen('https://cloud-images.ubuntu.com/noble/current/SHA256SUMS').read().decode()
    expected = next(line.split()[0] for line in checksums.splitlines() if line.split()[-1].lstrip('*') == 'noble-server-cloudimg-amd64.vmdk')
    digest = hashlib.file_digest(disk.open('rb'), 'sha256').hexdigest()
    if digest != expected:
        raise RuntimeError('Ubuntu image checksum mismatch')
    for name in ['client_key', 'host_key']:
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(BASE / name)], check=True)
    password = secrets.token_urlsafe(30)
    public_key = (BASE / 'client_key.pub').read_text().strip()
    host_public = (BASE / 'host_key.pub').read_text().strip()
    config = {
        'hostname': 'vps-manager-test',
        'users': ['default', {'name': 'vpstest', 'shell': '/bin/bash', 'lock_passwd': False, 'ssh_authorized_keys': [public_key]}],
        'ssh_pwauth': True,
        'chpasswd': {'expire': False, 'users': [{'name': 'vpstest', 'password': password, 'type': 'text'}]},
        'ssh_keys': {'ed25519_private': (BASE / 'host_key').read_text(), 'ed25519_public': host_public},
        'write_files': [{'path': '/etc/systemd/system/vps-manager-test.service', 'content': '[Unit]\nDescription=VPS Manager disposable test service\n[Service]\nExecStart=/usr/bin/sleep infinity\n[Install]\nWantedBy=multi-user.target\n'}],
        'runcmd': [['systemctl', 'daemon-reload'], ['systemctl', 'start', 'vps-manager-test.service']],
    }
    iso = pycdlib.PyCdlib()
    iso.new(interchange_level=3, joliet=3, vol_ident='cidata')
    entries = {'user-data': '#cloud-config\n' + json.dumps(config), 'meta-data': 'instance-id: vps-manager-acceptance-1\nlocal-hostname: vps-manager-test\n', 'network-config': 'version: 2\nethernets:\n  eth0:\n    match:\n      name: "en*"\n    dhcp4: true\n'}
    for i, (name, content) in enumerate(entries.items()):
        data = content.encode()
        iso.add_fp(io.BytesIO(data), len(data), iso_path=f'/FILE{i}.;1', joliet_path='/' + name)
    iso.write(str(BASE / 'seed.iso'))
    iso.close()
    vbox('createvm', '--name', VM, '--ostype', 'Ubuntu_64', '--basefolder', str(BASE), '--register')
    vbox('modifyvm', VM, '--memory', '2048', '--cpus', '2', '--firmware', 'bios', '--nic1', 'nat', '--natpf1', 'ssh,tcp,127.0.0.1,22222,,22', '--uart1', '0x3F8', '4', '--uartmode1', 'file', str(BASE / 'serial.log'))
    vbox('storagectl', VM, '--name', 'SATA', '--add', 'sata', '--controller', 'IntelAhci')
    vbox('storageattach', VM, '--storagectl', 'SATA', '--port', '0', '--device', '0', '--type', 'hdd', '--medium', str(disk))
    vbox('storageattach', VM, '--storagectl', 'SATA', '--port', '1', '--device', '0', '--type', 'dvddrive', '--medium', str(BASE / 'seed.iso'))
    fingerprint = subprocess.check_output(['ssh-keygen', '-lf', str(BASE / 'host_key.pub'), '-E', 'sha256'], text=True).split()[1]
    (BASE / 'connection.json').write_text(json.dumps({'host': '127.0.0.1', 'port': 22222, 'username': 'vpstest', 'password': password, 'keyPath': str(BASE / 'client_key'), 'fingerprint': fingerprint}, indent=2))
    vbox('startvm', VM, '--type', 'headless')
    print('Started disposable Ubuntu VM on loopback port 22222. Test credentials remain in ignored .test-data.')

if __name__ == '__main__':
    main()
