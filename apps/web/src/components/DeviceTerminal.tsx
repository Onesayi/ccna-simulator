import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CliSession, type Device } from '@ccna-sim/engine';
import { useNetwork } from '../state/network';

/** An xterm.js console bound to one device: the IOS CLI for routers and switches, a command prompt for PCs. */
export function DeviceTerminal({ device }: { device: Device }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const { shellFor, touch } = useNetwork.getState();
    const shell = shellFor(device);
    const term = new Terminal({ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, cursorBlink: true, convertEol: true });
    // Size the terminal to its panel so long IOS lines wrap instead of running off the edge.
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    fit.fit();
    const resize = new ResizeObserver(() => fit.fit());
    resize.observe(host.current!);
    term.focus();
    const history: string[] = [];
    let cursor = 0;
    let line = '';
    const prompt = () => term.write(shell.prompt);
    const replaceLine = (next: string) => {
      term.write('\b \b'.repeat(line.length));
      line = next;
      term.write(line);
    };
    term.writeln(`Connected to ${device.hostname}. Type ? for help.`);
    term.writeln('');
    prompt();

    const sub = term.onData((data) => {
      if (data === '\r') {
        term.write('\r\n');
        if (line.trim()) history.push(line);
        cursor = history.length;
        const out = shell.execute(line);
        if (out) term.writeln(out);
        touch();
        line = '';
        prompt();
      } else if (data === '\u007f') {
        if (line.length) {
          line = line.slice(0, -1);
          term.write('\b \b');
        }
      } else if (data === '\u001b[A') {
        if (cursor > 0) replaceLine(history[--cursor] ?? '');
      } else if (data === '\u001b[B') {
        if (cursor < history.length) replaceLine(history[++cursor] ?? '');
      } else if (data === '\u0003' || data === '\u001a') {
        // Ctrl+C / Ctrl+Z: drop the line, and leave config mode like IOS "end".
        term.write('^C\r\n');
        if (data === '\u001a' && shell.prompt.includes('(config')) shell.execute('end');
        line = '';
        prompt();
      } else if (data === '?' && shell instanceof CliSession) {
        // IOS shows help as soon as "?" is typed, without Enter.
        term.write('?\r\n');
        const out = shell.execute(`${line}?`);
        if (out) term.writeln(out);
        prompt();
        term.write(line);
      } else if (data >= ' ' && !data.startsWith('\u001b')) {
        line += data;
        term.write(data);
      }
    });
    return () => {
      resize.disconnect();
      sub.dispose();
      term.dispose();
    };
  }, [device]);

  return <div ref={host} className="terminal" />;
}
