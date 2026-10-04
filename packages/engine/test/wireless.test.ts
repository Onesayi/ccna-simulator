import { beforeEach, describe, expect, it } from 'vitest';
import { ApShell, LightweightAp, Pc, PcShell, Router, Server, ServerShell, Switch, Topology, WirelessController, WlcShell, createDevice, createShell, deriveMic, dissect, parseOption43, resetMacAllocator, summarize, wlanSecurity } from '../src';
import { ios } from './helpers';

/** R1 routes VLAN 10 (management) and 20 (staff); WLC1 trunks to SW1; AP1 sits in VLAN 10. */
function campus() {
  resetMacAllocator();
  const net = new Topology();
  const sw = net.add(new Switch('SW1'));
  const r1 = net.add(new Router('R1'));
  const wlc = net.add(new WirelessController('WLC1'));
  const ap = net.add(new LightweightAp('AP1'));
  const srv = net.add(new Server('SRV'));
  const lap = net.add(new Pc('LAPTOP1', { wireless: true }));
  const lap2 = net.add(new Pc('LAPTOP2', { wireless: true }));
  ios(r1, 'conf t\nint g0/0\nno shut\nint g0/0.10\nencapsulation dot1q 10\nip address 192.168.10.1 255.255.255.0\nint g0/0.20\nencapsulation dot1q 20\nip address 192.168.20.1 255.255.255.0\nexit\nip dhcp excluded-address 192.168.10.1 192.168.10.9\nip dhcp excluded-address 192.168.20.1 192.168.20.9\nip dhcp pool APS\nnetwork 192.168.10.0 255.255.255.0\ndefault-router 192.168.10.1\nip dhcp pool WIFI\nnetwork 192.168.20.0 255.255.255.0\ndefault-router 192.168.20.1');
  net.connect(r1.iface('g0/0'), sw.iface('g0/1'));
  net.connect(wlc.port, sw.iface('g0/2'));
  net.connect(srv.nic, sw.iface('g0/4'));
  ios(sw, 'conf t\nvlan 10\nvlan 20\nint g0/1\nswitchport mode trunk\nint g0/2\nswitchport mode trunk\nint g0/3\nswitchport access vlan 10\nint g0/4\nswitchport access vlan 10');
  net.connect(ap.nic, sw.iface('g0/3'));
  srv.configure('192.168.10.100', 24, '192.168.10.1');
  const w = new WlcShell(wlc);
  for (const c of [
    'config interface address management 192.168.10.5 255.255.255.0 192.168.10.1',
    'config interface vlan management 10',
    'config interface create staff 20',
    'config interface address dynamic-interface staff 192.168.20.5 255.255.255.0 192.168.20.1',
  ]) expect(w.execute(c)).toBe('');
  lap.renew();
  lap2.renew();
  net.converge();
  return { net, sw, r1, wlc, ap, srv, lap, lap2, w, pc: new PcShell(lap), pc2: new PcShell(lap2), aps: new ApShell(ap) };
}

const PSK = ['config wlan create 1 Staff Staff', 'config wlan interface 1 staff', 'config wlan security wpa akm 802.1x disable 1', 'config wlan security wpa akm psk enable 1', 'config wlan security wpa akm psk set-key ascii CorpWiFi2024 1', 'config wlan enable 1'];

describe('lightweight AP and controller', () => {
  let t: ReturnType<typeof campus>;
  beforeEach(() => (t = campus()));

  it('joins by broadcast discovery and reports it everywhere', () => {
    expect(t.ap.joined).toBe(true);
    expect(t.w.execute('show ap summary')).toMatch(/AP1 +2 +AIR-AP3802I-B-K9 .*192\.168\.10\.10/);
    expect(t.aps.execute('show capwap client rcb')).toContain('MwarName                    : WLC1');
    expect(t.aps.execute('show capwap ip config')).toContain('Disabled (DHCP)');
    expect(t.aps.execute('show ip interface brief')).toMatch(/Dot11Radio1 +unassigned +YES unset +up/);
    expect(t.aps.execute('show controllers dot11Radio 0')).toContain('Current Channel 1');
    expect(t.aps.execute('show controllers dot11radio1')).toContain('Beaconing SSIDs: none');
    expect(t.aps.execute('help')).toContain('capwap ap primary-base');
    expect(t.aps.execute('bogus')).toContain('% Invalid input');
    expect(t.aps.execute('ping 192.168.10.5')).toContain('Success rate is 100 percent');
    expect(t.aps.execute('ping x')).toContain('% Invalid input');
    expect(t.aps.prompt).toBe('AP1#');
    expect(t.w.execute('show sysinfo')).toContain('IP Address....................................... 192.168.10.5');
    expect(t.w.execute('show interface summary')).toMatch(/staff +1 +20 +192\.168\.20\.5 +Dynamic/);
    expect(t.w.execute('show msglog')).toContain('AP AP1 (192.168.10.10) joined');
    expect(t.w.execute('ping 192.168.10.1')).toBe('Send count=3, Receive count=3 from 192.168.10.1');
    // CAPWAP control is on the wire.
    const join = t.net.trace.find((e) => e.frame.payload.kind === 'udp' && e.frame.payload.capwap?.type === 'join-response')!.frame;
    expect(summarize(join).info).toContain('Join Response');
    expect(JSON.stringify(dissect(join))).toContain('AC Name');
  });

  it('drops the join when the controller goes away and rejoins after', () => {
    ios(t.sw, 'conf t\nint g0/2\nshutdown');
    expect(t.ap.joined).toBe(false);
    expect(t.ap.log.join('\n')).toContain('%CAPWAP-3-ERRORLOG');
    expect(t.wlc.aps.size).toBe(0);
    expect(t.aps.execute('show capwap client rcb')).toContain('not joined');
    ios(t.sw, 'conf t\nint g0/2\nno shutdown');
    expect(t.ap.joined).toBe(true);
    // An AP whose uplink fails notices at once.
    ios(t.sw, 'conf t\nint g0/3\nshutdown');
    expect(t.ap.joined).toBe(false);
  });

  it('finds a controller in another subnet through option 43 or priming', () => {
    expect(parseOption43('f108.c0a8.0a05.c0a8.0a06')).toEqual(['192.168.10.5', '192.168.10.6']);
    expect(parseOption43('0104c0a80a05')).toEqual([]);
    expect(parseOption43(undefined)).toEqual([]);
    ios(t.r1, 'conf t\nint g0/0.30\nencapsulation dot1q 30\nip address 192.168.30.1 255.255.255.0\nexit\nip dhcp excluded-address 192.168.30.1 192.168.30.9\nip dhcp pool APS30\nnetwork 192.168.30.0 255.255.255.0\ndefault-router 192.168.30.1');
    ios(t.sw, 'conf t\nvlan 30\nint g0/3\nswitchport access vlan 30');
    t.net.converge();
    expect(t.ap.nic.ip?.address).toMatch(/^192\.168\.30\./);
    expect(t.ap.joined).toBe(false);
    ios(t.r1, 'conf t\nip dhcp pool APS30\noption 43 hex f104.c0a8.0a05');
    expect(t.ap.joined).toBe(true);
    expect(t.aps.execute('show capwap ip config')).toContain('DHCP Option 43 Controllers    : 192.168.10.5');
    const cli = createShell(t.r1);
    cli.execute('enable');
    expect(cli.execute('show running-config')).toContain(' option 43 hex f104.c0a8.0a05');
    expect(ios(t.r1, 'conf t\nip dhcp pool APS30\nno option 43')).toBe('');
    expect(() => ios(t.r1, 'conf t\nip dhcp pool APS30\noption 43 hex xyz')).toThrow(/Invalid hex/);
  });

  it('takes a static address and a primed controller', () => {
    const a = t.aps;
    expect(a.execute('capwap ap ip default-gateway 192.168.10.1')).toContain('static address first');
    expect(a.execute('capwap ap ip address 192.168.10.50 255.255.255.0')).toBe('');
    expect(a.execute('capwap ap ip default-gateway 192.168.10.1')).toBe('');
    expect(a.execute('capwap ap ip address bad 255.255.255.0')).toContain('Invalid');
    expect(a.execute('capwap ap ip default-gateway bad')).toContain('Invalid');
    expect(a.execute('capwap ap primary-base WLC1 bad')).toContain('Invalid');
    expect(a.execute('capwap ap primary-base WLC1 192.168.10.5')).toBe('');
    expect(t.ap.joined).toBe(true);
    expect(t.ap.nic.ip?.address).toBe('192.168.10.50');
    expect(a.execute('show capwap ip config')).toContain('Primary Controller            : WLC1 192.168.10.5');
    expect(a.execute('clear capwap ap primary-base')).toBe('');
    expect(a.execute('clear capwap ap ip address')).toBe('');
    expect(t.ap.dhcp).toBe(true);
    expect(t.ap.joined).toBe(true);
  });

  it('assigns non-overlapping channels with DCA and flags a bad static plan', () => {
    const ap2 = t.net.add(new LightweightAp('AP2'));
    t.net.connect(ap2.nic, t.sw.iface('g0/5'));
    ios(t.sw, 'conf t\nint g0/5\nswitchport access vlan 10');
    expect(t.wlc.channelsFor('AP1')).toEqual([1, 36]);
    expect(t.wlc.channelsFor('AP2')).toEqual([6, 40]);
    expect(t.w.execute('config 802.11b channel ap AP2 3')).toBe('');
    expect(t.w.execute('show advanced 802.11b summary')).toMatch(/AP2 +3 +Static +overlapping with AP1/);
    expect(t.w.execute('config 802.11a channel ap AP2 36')).toBe('');
    expect(t.w.execute('show advanced 802.11a summary')).toMatch(/AP2 +36 +Static +co-channel with AP1/);
    expect(t.w.execute('config 802.11b channel ap AP2 12')).toContain('not a valid 802.11b channel');
    expect(t.w.execute('config 802.11a channel ap AP2 37')).toContain('not a valid 802.11a channel');
    expect(ap2.channels).toEqual([3, 36]);
    expect(t.w.execute('show run-config commands')).toContain('config 802.11b channel ap AP2 3');
    expect(t.w.execute('config 802.11b channel ap AP2 global')).toBe('');
    expect(t.w.execute('config 802.11a channel ap AP2 global')).toBe('');
    expect(t.w.execute('config 802.11b channel global auto')).toBe('');
    expect(t.wlc.channelsFor('AP2')).toEqual([6, 40]);
    expect(WirelessController.overlaps24(1, 6)).toBe(false);
  });
});

describe('WLANs and clients', () => {
  let t: ReturnType<typeof campus>;
  beforeEach(() => (t = campus()));

  it('joins a WPA2-PSK WLAN, gets DHCP in the WLAN VLAN and pings through the tunnel', () => {
    for (const c of PSK) expect(t.w.execute(c)).toBe('');
    expect(t.w.execute('show wlan summary')).toMatch(/1 +Staff \/ Staff +Enabled +staff/);
    expect(t.w.execute('show wlan 1')).toContain('[WPA2][Auth(PSK)]');
    const nets = t.pc.execute('netsh wlan show networks');
    expect(nets).toContain('SSID 1 : Staff');
    expect(nets).toContain('WPA2-Personal');
    expect(t.pc.execute('netsh wlan connect ssid=Staff key=WrongKey99')).toContain('The network security key isn\'t correct.');
    expect(t.w.execute('show msglog')).toContain('MIC validation failed');
    expect(t.pc.execute('netsh wlan connect ssid=Staff key=CorpWiFi2024')).toBe('Connection request was completed successfully.');
    expect(t.lap.nic.ip?.address).toMatch(/^192\.168\.20\./);
    expect(t.pc.execute('netsh wlan show interfaces')).toContain('Channel                : 36');
    expect(t.pc.execute('ping 192.168.20.1')).toContain('Received = 4');
    expect(t.pc.execute('ipconfig')).toContain('Wireless0 Connection');
    expect(t.w.execute('show client summary')).toMatch(/RUN .*192\.168\.20\./);
    expect(t.aps.execute('show dot11 associations')).toContain('LAPTOP1');
    // Client to client stays on the controller; broadcasts reach the other client too.
    t.pc2.execute('netsh wlan connect ssid=Staff key=CorpWiFi2024');
    expect(t.pc.execute(`ping ${t.lap2.nic.ip!.address}`)).toContain('Received = 4');
    // The capture shows the client frame inside CAPWAP data, and the handshake as EAPOL.
    const tunneled = t.net.trace.find((e) => e.frame.payload.kind === 'udp' && e.frame.payload.capwap?.type === 'data' && e.frame.payload.capwap.inner?.payload.kind === 'icmp')!.frame;
    expect(summarize(tunneled).protocol).toBe('CAPWAP-Data');
    expect(JSON.stringify(dissect(tunneled))).toContain('[tunneled]');
    expect(t.net.trace.some((e) => summarize(e.frame).protocol === 'EAPOL')).toBe(true);
    expect(t.pc.execute('netsh wlan disconnect')).toContain('completed successfully');
    expect(t.lap.wifi!.connected).toBe(false);
  });

  it('reconnects on its own when the WLAN or AP comes back', () => {
    for (const c of PSK) t.w.execute(c);
    t.pc.execute('netsh wlan connect ssid=Staff key=CorpWiFi2024');
    expect(t.w.execute('config wlan disable 1')).toBe('');
    expect(t.lap.wifi!.connected).toBe(false);
    expect(t.w.execute('config wlan enable 1')).toBe('');
    expect(t.lap.wifi!.connected).toBe(true);
    ios(t.sw, 'conf t\nint g0/3\nshutdown');
    expect(t.pc.execute('netsh wlan show interfaces')).toContain('State                  : disconnected');
    ios(t.sw, 'conf t\nint g0/3\nno shutdown');
    expect(t.lap.wifi!.connected).toBe(true);
    expect(t.w.execute(`config client deauthenticate ${t.lap.nic.mac}`)).toBe('');
    expect(t.w.execute('config client deauthenticate 0000.1111.2222')).toContain('not found');
  });

  it('authenticates WPA3-SAE at the auth exchange', () => {
    for (const c of ['config wlan create 3 Guest Guest', 'config wlan security wpa wpa3 enable 3', 'config wlan security wpa wpa2 disable 3', 'config wlan security wpa akm 802.1x disable 3']) t.w.execute(c);
    expect(t.w.execute('config wlan enable 3')).toContain('Request failed - WPA3 needs the SAE AKM');
    t.w.execute('config wlan security wpa akm sae enable 3');
    expect(t.w.execute('config wlan enable 3')).toContain('SAE requires a PSK');
    t.w.execute('config wlan security wpa akm psk set-key ascii GuestPass99 3');
    expect(t.w.execute('config wlan enable 3')).toBe('');
    expect(t.pc.execute('netsh wlan show networks')).toContain('WPA3-Personal');
    expect(t.pc.execute('netsh wlan connect ssid=Guest')).toContain('security key is required');
    expect(t.pc.execute('netsh wlan connect ssid=Guest key=nope12345')).toContain('isn\'t correct');
    expect(t.w.execute('show msglog')).toContain('SAE authentication failed');
    expect(t.pc.execute('netsh wlan connect ssid=Guest key=GuestPass99')).toContain('successfully');
    // Guest clients land in the management VLAN (the default interface).
    expect(t.lap.nic.ip?.address).toMatch(/^192\.168\.10\./);
  });

  it('checks 802.1X users against RADIUS', () => {
    const admin = new ServerShell(t.srv);
    admin.execute('aaa client add 192.168.10.5 RadKey123');
    admin.execute('aaa user add alice Wonder1');
    expect(t.w.execute('config radius auth add 1 192.168.10.100 1812 ascii RadKey123')).toBe('');
    expect(t.w.execute('config radius auth add 1 192.168.10.100 1812 ascii RadKey123')).toContain('in use');
    expect(t.w.execute('config radius auth add 99 192.168.10.100 1812 ascii x')).toContain('Incorrect input');
    for (const c of ['config wlan create 2 Corp Corp', 'config wlan interface 2 staff', 'config wlan radius_server auth add 2 1', 'config wlan enable 2']) expect(t.w.execute(c)).toBe('');
    expect(t.w.execute('config wlan radius_server auth add 2 1')).toContain('must be disabled');
    expect(t.pc.execute('netsh wlan connect ssid=Corp')).toContain('user name and password');
    expect(t.pc.execute('netsh wlan connect ssid=Corp user=alice password=wrong')).toContain('rejected by the authentication server');
    expect(t.pc.execute('netsh wlan connect ssid=Corp user=alice password=Wonder1')).toContain('successfully');
    expect(t.lap.nic.ip?.address).toMatch(/^192\.168\.20\./);
    expect(t.w.execute('show client summary')).toContain('alice');
    expect(t.w.execute('show radius summary')).toMatch(/1 +192\.168\.10\.100 +1812 +Enabled +2 +1 +1 +0/);
    expect(admin.execute('aaa log')).toContain('RADIUS Passed authentication: alice');
    // A dead RADIUS server: the client is told the server did not respond.
    admin.execute('aaa client delete 192.168.10.5');
    expect(t.pc2.execute('netsh wlan connect ssid=Corp user=alice password=Wonder1')).toContain('did not respond');
    expect(t.w.execute('config wlan disable 2')).toBe('');
    expect(t.w.execute('config radius auth delete 1')).toBe('');
    expect(t.w.execute('config radius auth delete 1')).toContain('not configured');
    expect(t.w.execute('config wlan radius_server auth add 2 1')).toContain('not configured');
  });

  it('validates WLAN and interface commands like AireOS', () => {
    const w = t.w;
    expect(w.prompt).toBe('(WLC1) >');
    expect(w.execute('')).toBe('');
    expect(w.execute('help')).toContain('config wlan create');
    expect(w.execute('show nonsense')).toContain('Incorrect input');
    expect(w.execute('config wlan create 0 A A')).toContain('WLAN identifier must be 1 to 512');
    expect(w.execute('config wlan create 1 Staff Staff')).toBe('');
    expect(w.execute('config wlan create 1 X X')).toContain('already exists');
    expect(w.execute('config wlan create 2 Staff Other')).toContain('already in use');
    expect(w.execute('config wlan enable 9')).toContain('does not exist');
    expect(w.execute('show wlan 9')).toContain('does not exist');
    expect(w.execute('config wlan security wpa akm 802.1x disable 1')).toBe('');
    expect(w.execute('config wlan enable 1')).toContain('no AKM');
    expect(w.execute('config wlan security wpa akm psk enable 1')).toBe('');
    expect(w.execute('config wlan enable 1')).toContain('no key is set');
    expect(w.execute('config wlan security wpa akm psk set-key ascii short 1')).toContain('8 to 63');
    expect(w.execute('config wlan security wpa akm psk maybe 1')).toContain('Incorrect input');
    expect(w.execute('config wlan interface 1 nowhere')).toContain('does not exist');
    expect(w.execute('config wlan security wpa disable 1')).toBe('');
    expect(w.execute('config wlan security wpa wpa2 disable 1')).toBe('');
    expect(w.execute('config wlan enable 1')).toBe('');
    expect(w.execute('show wlan 1')).toContain('Result........................................... None');
    expect(w.execute('config wlan delete 1')).toContain('must be disabled');
    expect(w.execute('config wlan disable 1')).toBe('');
    expect(w.execute('config wlan delete 1')).toBe('');
    expect(w.execute('config interface create staff 30')).toContain('already exists');
    expect(w.execute('config interface create x 5000')).toContain('VLAN identifier');
    expect(w.execute('config interface vlan nowhere 5')).toContain('does not exist');
    expect(w.execute('config interface address dynamic-interface nowhere 10.0.0.1 255.0.0.0 10.0.0.254')).toContain('does not exist');
    expect(w.execute('config interface address management bad 255.0.0.0 10.0.0.1')).toContain('not a valid IP');
    expect(w.execute('config interface delete management')).toContain('cannot be deleted');
    w.execute('config wlan create 4 Lab Lab');
    w.execute('config wlan interface 4 staff');
    expect(w.execute('config interface delete staff')).toContain('in use');
    w.execute('config wlan delete 4');
    expect(w.execute('config interface delete staff')).toBe('');
    expect(w.execute('config sysname CORE-WLC')).toBe('');
    expect(w.prompt).toBe('(CORE-WLC) >');
    expect(w.execute('save config')).toBe('Configuration Saved!');
    expect(w.execute('show run-config commands')).toContain('config interface vlan management 10');
    expect(wlanSecurity({ id: 1, profile: 'a', ssid: 'a', enabled: false, interface: 'management', wpa: true, wpa2: true, wpa3: false, akm: { psk: false, sae: false, dot1x: true }, radius: [] })).toBe('wpa2-enterprise');
  });

  it('lists the full configuration as commands', () => {
    for (const c of PSK) t.w.execute(c);
    t.w.execute('config radius auth add 2 192.168.10.100 1812 ascii k');
    t.w.execute('config wlan create 3 G G');
    t.w.execute('config wlan security wpa wpa3 enable 3');
    t.w.execute('config wlan security wpa wpa2 disable 3');
    t.w.execute('config wlan security wpa akm sae enable 3');
    t.w.execute('config wlan radius_server auth add 3 2');
    const cfg = t.w.execute('show run-config commands');
    expect(cfg).toContain('config wlan security wpa akm psk set-key ascii **** 1');
    expect(cfg).toContain('config wlan security wpa wpa3 enable 3');
    expect(cfg).toContain('config wlan radius_server auth add 3 2');
    expect(cfg).toContain('config radius auth add 2 192.168.10.100 1812 ascii ****');
    expect(t.w.execute('show wlan 3')).toContain('Radius Servers................................ 2');
  });
});

describe('Wi-Fi clients', () => {
  it('needs a radio, a network in range and a profile', () => {
    const t = campus();
    const wired = new PcShell(t.net.add(new Pc('PC9')));
    expect(wired.execute('netsh wlan show networks')).toBe('There is no wireless interface on the system.');
    expect(wired.execute('netsh interface show')).toContain('not found');
    expect(wired.execute('help')).not.toContain('netsh');
    expect(t.pc.execute('help')).toContain('netsh wlan connect');
    expect(t.pc.execute('netsh wlan connect')).toContain('Usage');
    expect(t.pc.execute('netsh wlan bogus')).toContain('Usage');
    expect(t.pc.execute('netsh wlan connect ssid=Nowhere key=x')).toContain('no profile "Nowhere" network in range');
    expect(t.pc.execute('netsh wlan show interfaces')).toContain('State                  : disconnected');
    expect(t.pc.execute('ping 192.168.20.1')).toContain('General failure');
  });

  it('builds devices through the factory and shells', () => {
    expect(createDevice('wlc', 'W')).toBeInstanceOf(WirelessController);
    expect(createDevice('ap', 'A')).toBeInstanceOf(LightweightAp);
    expect((createDevice('pc', 'L', { wireless: true }) as Pc).wifi).toBeDefined();
    expect(createShell(new WirelessController('W'))).toBeInstanceOf(WlcShell);
    expect(createShell(new LightweightAp('A'))).toBeInstanceOf(ApShell);
    expect(deriveMic('a', 'b')).not.toBe(deriveMic('a', 'c'));
  });
});
