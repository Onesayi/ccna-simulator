import { beforeEach, describe, expect, it } from 'vitest';
import { CliSession, Router, Server, ServerShell, Switch, Topology, parseInventory, resetMacAllocator, restconf, runPlaybook, splitArgs, type Connector } from '../src';
import { ios } from './helpers';

function lab() {
  resetMacAllocator();
  const net = new Topology();
  const sw = net.add(new Switch('SW1'));
  const r1 = net.add(new Router('R1'));
  const srv = net.add(new Server('SRV'));
  net.connect(srv.nic, sw.iface('g0/2'));
  net.connect(r1.iface('g0/0'), sw.iface('g0/3'));
  srv.configure('192.168.1.100', 24, '192.168.1.1');
  ios(r1, 'conf t\nint g0/0\nip address 192.168.1.1 255.255.255.0\nno shut\nusername admin privilege 15 secret Cisco123\nusername guest secret Guest1');
  return { net, r1, srv, sh: new ServerShell(srv) };
}

const BASE = 'curl -k -u admin:Cisco123 https://192.168.1.1/restconf/data';
const G01 = 'interface=GigabitEthernet0%2F1';

describe('RESTCONF', () => {
  let t: ReturnType<typeof lab>;
  beforeEach(() => (t = lab()));

  it('needs the HTTPS server, restconf and a privilege 15 user', () => {
    expect(t.sh.execute(`${BASE}/ietf-interfaces:interfaces`)).toContain('Connection refused');
    ios(t.r1, 'conf t\nip http secure-server\nip http authentication local');
    expect(t.sh.execute(`${BASE}/ietf-interfaces:interfaces`)).toContain('404 Not Found');
    ios(t.r1, 'conf t\nrestconf');
    expect(t.sh.execute('curl -u admin:Cisco123 https://192.168.1.1/restconf')).toContain('self-signed certificate');
    expect(t.sh.execute('curl -k -u admin:Cisco123 https://192.168.1.1/restconf')).toContain('yang-library-version');
    expect(t.sh.execute('curl -k -u admin:bad https://192.168.1.1/restconf')).toContain('access-denied');
    expect(t.sh.execute('curl -k -i -u guest:Guest1 https://192.168.1.1/restconf')).toContain('HTTP/1.1 401 Unauthorized');
    const cli = new CliSession(t.r1, { loggedIn: true });
    cli.execute('enable');
    expect(cli.execute('show running-config')).toContain('ip http authentication local\nip http secure-server');
    expect(cli.execute('show running-config')).toMatch(/\nrestconf\n/);
    expect(cli.execute('show platform software yang-management process')).toContain('nginx');
  });

  it('reads configuration and state as YANG JSON', () => {
    ios(t.r1, 'conf t\nip http secure-server\nrestconf\nint g0/0\ndescription LAN');
    const one = JSON.parse(t.sh.execute(`${BASE}/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F0`)) as { 'ietf-interfaces:interface': { name: string; description: string; 'ietf-ip:ipv4': unknown }[] };
    expect(one['ietf-interfaces:interface'][0]).toMatchObject({ name: 'GigabitEthernet0/0', description: 'LAN', 'ietf-ip:ipv4': { address: [{ ip: '192.168.1.1', netmask: '255.255.255.0' }] } });
    expect(t.sh.execute(`${BASE}/ietf-interfaces:interfaces`)).toContain('GigabitEthernet0/2');
    expect(t.sh.execute(`${BASE}/ietf-interfaces:interfaces/interface=GigabitEthernet0%2F0/description`)).toContain('"ietf-interfaces:description": "LAN"');
    expect(t.sh.execute(`${BASE}/ietf-interfaces:interfaces-state/interface=GigabitEthernet0%2F0`)).toContain('"oper-status": "up"');
    expect(t.sh.execute(`${BASE}/ietf-interfaces:interfaces-state`)).toContain('"admin-status": "down"');
    expect(t.sh.execute(`${BASE}/Cisco-IOS-XE-native:native`)).toContain('"hostname": "R1"');
    expect(t.sh.execute(`${BASE}/Cisco-IOS-XE-native:native/hostname`)).toContain('"Cisco-IOS-XE-native:hostname": "R1"');
    expect(t.sh.execute(`curl -k -i -u admin:Cisco123 https://192.168.1.1/restconf/data/ietf-interfaces:interfaces/interface=Gi9%2F9`)).toContain('404 Not Found');
  });

  it('changes configuration with PATCH, POST and DELETE', () => {
    ios(t.r1, 'conf t\nip http secure-server\nrestconf');
    const body = '{"ietf-interfaces:interface":{"name":"GigabitEthernet0/1","description":"To R2","enabled":true,"ietf-ip:ipv4":{"address":[{"ip":"10.0.0.1","netmask":"255.255.255.252"}]}}}';
    expect(t.sh.execute(`curl -k -i -u admin:Cisco123 -X PATCH -d '${body}' https://192.168.1.1/restconf/data/ietf-interfaces:interfaces/${G01}`)).toContain('204 No Content');
    const g01 = t.r1.iface('g0/1');
    expect(g01.description).toBe('To R2');
    expect(g01.adminUp).toBe(true);
    expect(g01.ip).toEqual({ address: '10.0.0.1', prefix: 30 });
    expect(t.sh.execute(`curl -k -u admin:Cisco123 -X DELETE https://192.168.1.1/restconf/data/ietf-interfaces:interfaces/${G01}/description`)).toBe('');
    expect(g01.description).toBeUndefined();
    const lo = '{"ietf-interfaces:interface":{"name":"Loopback0","ietf-ip:ipv4":{"address":[{"ip":"1.1.1.1","netmask":"255.255.255.255"}]}}}';
    expect(t.sh.execute(`curl -k -i -u admin:Cisco123 -X POST -d '${lo}' ${BASE.replace('curl -k -u admin:Cisco123 ', '')}/ietf-interfaces:interfaces`)).toContain('201 Created');
    expect(t.r1.findIface('Loopback0')?.ip?.address).toBe('1.1.1.1');
    expect(t.sh.execute(`${BASE.replace('curl', 'curl -i')}/ietf-interfaces:interfaces -d '${lo}'`)).toContain('409 Conflict');
    expect(t.sh.execute(`${BASE} -X PATCH -d '{"Cisco-IOS-XE-native:hostname":"Edge1"}' `.replace(BASE, `${BASE}/Cisco-IOS-XE-native:native/hostname`))).toBe('');
    expect(t.r1.hostname).toBe('Edge1');
  });

  it('answers errors the way IOS XE does', () => {
    const r = (m: string, p: string, b?: string) => restconf(t.r1, m, p, b);
    expect(r('POST', '/restconf').status).toBe(405);
    expect(r('GET', '/restconf/data').status).toBe(404);
    expect(r('GET', '/restconf/data/foo:bar').status).toBe(404);
    expect(r('PUT', '/restconf/data/ietf-interfaces:interfaces').status).toBe(405);
    expect(r('POST', '/restconf/data/ietf-interfaces:interfaces', 'not json').status).toBe(400);
    expect(r('POST', '/restconf/data/ietf-interfaces:interfaces', '{"ietf-interfaces:interface":{"name":"Bogus1"}}').status).toBe(400);
    expect(r('PATCH', `/restconf/data/ietf-interfaces:interfaces/${G01}`, '[1]').status).toBe(400);
    expect(r('PATCH', `/restconf/data/ietf-interfaces:interfaces/${G01}`, '{"ietf-interfaces:interface":{"ietf-ip:ipv4":{"address":[{"ip":"192.168.1.5","netmask":"255.255.255.0"}]}}}').status).toBe(400);
    expect(r('PATCH', `/restconf/data/ietf-interfaces:interfaces/${G01}/enabled`, '{"ietf-interfaces:enabled":false}').status).toBe(204);
    expect(r('GET', `/restconf/data/ietf-interfaces:interfaces/${G01}/nope`).status).toBe(404);
    expect(r('DELETE', `/restconf/data/ietf-interfaces:interfaces/${G01}`).status).toBe(405);
    expect(r('POST', '/restconf/data/ietf-interfaces:interfaces-state').status).toBe(405);
    expect(r('GET', '/restconf/data/ietf-interfaces:interfaces-state/interface=Gi9').status).toBe(404);
    expect(r('PATCH', '/restconf/data/Cisco-IOS-XE-native:native').status).toBe(405);
    expect(r('GET', '/restconf/data/Cisco-IOS-XE-native:native/banner').status).toBe(404);
    expect(r('PATCH', '/restconf/data/Cisco-IOS-XE-native:native/hostname', '{"hostname":"1bad"}').status).toBe(400);
    expect(r('PATCH', '/restconf/data/Cisco-IOS-XE-native:native/hostname', '{"hostname":"SW1"}').status).toBe(400);
    expect(r('DELETE', '/restconf/data/Cisco-IOS-XE-native:native/hostname').status).toBe(405);
  });
});

const INVENTORY = `# lab routers
[routers]
R1 ansible_host=192.168.1.1

[routers:vars]
ansible_user=admin
ansible_password=Cisco123
ansible_connection=ansible.netcommon.network_cli
ansible_network_os=cisco.ios.ios
`;

const SITE = `---
- name: Configure routers
  hosts: routers
  gather_facts: false
  tasks:
    - name: Set loopback
      ios_config:
        lines:
          - ip address 1.1.1.1 255.255.255.255
        parents: interface Loopback0
        save_when: modified
    - name: Show
      ios_command:
        commands: show ip interface brief
      register: out
    - debug:
        var: out.stdout_lines
`;

describe('Ansible', () => {
  let t: ReturnType<typeof lab>;
  beforeEach(() => {
    t = lab();
    t.srv.files.set('hosts', INVENTORY);
    t.srv.files.set('site.yml', SITE);
  });

  it('cannot reach a device without SSH', () => {
    const out = t.sh.execute('ansible-playbook -i hosts site.yml');
    expect(out).toContain('fatal: [R1]: UNREACHABLE!');
    expect(out).toContain('Connection refused');
    expect(out).toMatch(/R1 +: ok=0 +changed=0 +unreachable=1/);
  });

  it('configures over SSH and is idempotent', () => {
    ios(t.r1, 'conf t\nip domain-name lab\ncrypto key generate rsa modulus 2048\nline vty 0 4\nlogin local\ntransport input ssh');
    const first = t.sh.execute('ansible-playbook -i hosts site.yml');
    expect(first).toContain('PLAY [Configure routers] ***');
    expect(first).toContain('changed: [R1]');
    expect(first).toContain('Loopback0              1.1.1.1');
    expect(first).toMatch(/R1 +: ok=3 +changed=1 +unreachable=0 +failed=0/);
    expect(t.r1.findIface('Loopback0')?.ip?.address).toBe('1.1.1.1');
    expect(t.sh.execute('ansible-playbook -i hosts site.yml')).toMatch(/R1 +: ok=3 +changed=0/);
    expect(t.sh.execute('ls')).toBe('hosts  site.yml');
    expect(t.sh.execute('cat site.yml')).toContain('ios_config');
    expect(t.sh.execute('cat nope')).toContain('No such file');
    expect(t.sh.execute('nano site.yml')).toContain('Files tab');
    // Wrong credentials fail the login.
    t.srv.files.set('bad', INVENTORY.replace('Cisco123', 'nope'));
    expect(t.sh.execute('ansible-playbook -i bad site.yml')).toContain('Authentication failed');
    expect(t.sh.execute('ansible-playbook -i hosts missing.yml')).toContain('could not be found');
    expect(t.sh.execute('ansible-playbook -i nope site.yml')).toContain('No inventory was parsed');
    expect(t.sh.execute('ansible-playbook')).toContain('usage');
  });

  it('gathers facts, templates variables and reports failures', () => {
    ios(t.r1, 'conf t\nip domain-name lab\ncrypto key generate rsa modulus 2048\nline vty 0 4\nlogin local\ntransport input ssh');
    t.srv.files.set('facts.yml', `- hosts: all
  vars:
    banner: Managed by Ansible
  tasks:
    - debug:
        msg: "{{ inventory_hostname }} runs {{ ansible_net_version }}: {{ banner }}"
    - ios_command:
        commands:
          - show bogus
`);
    const out = t.sh.execute('ansible-playbook -i hosts facts.yml');
    expect(out).toContain('TASK [Gathering Facts]');
    expect(out).toContain('"msg": "R1 runs 15.');
    expect(out).toContain('Managed by Ansible');
    expect(out).toContain('fatal: [R1]: FAILED!');
    expect(out).toMatch(/failed=1/);
  });
});

describe('runPlaybook', () => {
  const fake: Connector = () => ({
    conn: { run: () => '', runningConfig: () => 'hostname R1', facts: () => ({}) },
  });

  it('parses inventories with group and host variables', () => {
    const inv = parseInventory('top1 x=1\n[core]\nR1 ansible_host=10.0.0.1 x=5 ; comment\nR2\n[core:vars]\nx=2\nflag=yes\nname="q"\n[all:vars]\ny=no');
    expect(inv.groups.get('all')).toEqual(['top1', 'R1', 'R2']);
    expect(inv.groups.get('ungrouped')).toEqual(['top1']);
    expect(inv.hosts.get('R1')).toEqual({ x: 5, flag: true, name: 'q', y: false, ansible_host: '10.0.0.1' });
    expect(inv.hosts.get('R2')).toMatchObject({ x: 2 });
  });

  it('rejects broken playbooks and connections', () => {
    expect(runPlaybook('a: [', '', fake)).toContain('Syntax Error');
    expect(runPlaybook('a: 1', '', fake)).toContain('must be a list of plays');
    expect(runPlaybook('- tasks: []', '', fake)).toContain("'hosts' is required");
    expect(runPlaybook('- hosts: all\n  tasks:\n    - name: x\n      ios_cmd: {}', 'R1', fake)).toContain("couldn't resolve module/action 'ios_cmd'");
    expect(runPlaybook('- hosts: all\n  tasks:\n    - name: x', 'R1', fake)).toContain('no module/action detected');
    expect(runPlaybook('- hosts: web\n  tasks: []', 'R1', fake)).toContain('Could not match supplied host pattern');
    const play = '- hosts: R1\n  gather_facts: no\n  tasks:\n    - ios_command:\n        commands: show version';
    expect(runPlaybook(play, 'R1', fake)).toContain('Connection type ssh is not valid');
    expect(runPlaybook(play, 'R1 ansible_connection=network_cli', fake)).toContain('Unable to automatically determine host network os');
    expect(runPlaybook(play, 'R1 ansible_connection=network_cli ansible_network_os=junos', fake)).toContain('network os junos is not supported');
    expect(runPlaybook(play, 'R1 ansible_connection=network_cli ansible_network_os=ios', () => ({ error: 'nope' }))).toContain('"msg":"nope"');
    const ok = 'R1 ansible_connection=network_cli ansible_network_os=ios ansible_become=yes ansible_become_password=x';
    expect(runPlaybook('- hosts: R1\n  gather_facts: no\n  tasks:\n    - ios_command: {}', ok, fake)).toContain('missing required arguments: commands');
    expect(runPlaybook('- hosts: R1\n  gather_facts: no\n  tasks:\n    - ios_config: {}', ok, fake)).toContain('one of lines');
    expect(runPlaybook('- hosts: R1\n  gather_facts: no\n  tasks:\n    - debug: {}\n    - debug:\n        var: nope', ok, fake)).toContain('VARIABLE IS NOT DEFINED!');
  });
});

describe('splitArgs', () => {
  it('keeps quoted strings together', () => {
    expect(splitArgs(`curl -d '{"a": 1}' -H "X: \\"y\\"" url`)).toEqual(['curl', '-d', '{"a": 1}', '-H', 'X: "y"', 'url']);
  });
});
