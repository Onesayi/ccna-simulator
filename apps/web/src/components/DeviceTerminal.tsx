import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { CliSession, Pc, type Device } from '@ccna-sim/engine';
import { useNetwork } from '../state/network';

/** An xterm.js console bound to one device. PCs get a minimal shell; network devices get the IOS CLI. */
export function DeviceTerminal({ device }: { device: Device }) {
  const host = useRef<HTMLDivElement>(null);
  const run = useNetwork((s) => s.run);

  useEffect(() => {
    const term = new Terminal({ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13, cursorBlink: true });
    term.open(host.current!);
    const cli = new CliSession(device);
    const prompt = () => (device instanceof Pc ? `C:\\${device.hostname}> ` : cli.prompt);
    let line = '';
    term.writeln(`Connected to ${device.hostname}. Type ? for help.`);
    term.write(prompt());

    const execute = (input: string): string => {
      if (device instanceof Pc) {
        const m = /^ping\s+(\S+)/.exec(input.trim());
        if (!m) return input.trim() ? "Only 'ping <ip>' is available in this preview." : '';
        const results = device.ping(m[1]!);
        run();
        return results.map((r) => (r.success ? `Reply from ${m[1]}: time=${r.rttMs}ms TTL=64` : 'Request timed out.')).join('\r\n');
      }
      return cli.execute(input).replace(/\n/g, '\r\n');
    };

    const sub = term.onData((data) => {
      if (data === '\r') {
        term.write('\r\n');
        const out = execute(line);
        if (out) term.write(out + '\r\n');
        line = '';
        term.write(prompt());
      } else if (data === '\u007f') {
        if (line.length) {
          line = line.slice(0, -1);
          term.write('\b \b');
        }
      } else if (data >= ' ') {
        line += data;
        term.write(data);
      }
    });
    return () => {
      sub.dispose();
      term.dispose();
    };
  }, [device, run]);

  return <div ref={host} className="terminal" />;
}
