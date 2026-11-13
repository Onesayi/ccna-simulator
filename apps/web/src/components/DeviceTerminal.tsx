import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Device } from '@ccna-sim/engine';
import { useNetwork } from '../state/network';

/** A name lookup that found nothing: the "Translating..." line, then the error once the lookup gives up. */
const FAILED_LOOKUP = /^(Translating "[^"\n]*"\.\.\.domain server \([^\n]*\))\n(% (?:Unknown command|Unrecognized host)[\s\S]*)$/;
const LOOKUP_PAUSE_MS = 1500;

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
    term.writeln(`Connected to ${device.hostname}. Type ? for help, Tab to complete a command.`);
    term.writeln('');
    prompt();

    // While IOS "translates" a mistyped command it ignores the keyboard for a moment.
    let busy = false;
    const sub = term.onData((data) => {
      if (busy) return;
      if (data === '\r') {
        term.write('\r\n');
        if (line.trim() && !shell.masked) history.push(line);
        cursor = history.length;
        const out = shell.execute(line);
        touch();
        line = '';
        const lookup = FAILED_LOOKUP.exec(out);
        if (lookup) {
          busy = true;
          term.writeln(lookup[1]!);
          window.setTimeout(() => {
            busy = false;
            term.writeln(lookup[2]!);
            prompt();
          }, LOOKUP_PAUSE_MS);
          return;
        }
        if (out) term.writeln(out);
        prompt();
      } else if (data === '\u007f') {
        if (line.length) {
          line = line.slice(0, -1);
          if (!shell.masked) term.write('\b \b');
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
      } else if (data === '?' && shell.instantHelp) {
        // IOS shows help as soon as "?" is typed, without Enter.
        term.write('?\r\n');
        const out = shell.execute(`${line}?`);
        if (out) term.writeln(out);
        prompt();
        term.write(line);
      } else if (data === '\t') {
        // IOS Tab: finish the keyword being typed, or reprint the line when it is ambiguous or unknown.
        if (shell.masked) return;
        const done = shell.complete?.(line);
        if (done === undefined) return;
        if (done !== line && done.startsWith(line)) {
          term.write(done.slice(line.length));
          line = done;
        } else if (done !== line) {
          replaceLine(done);
        } else {
          term.write('\r\n');
          prompt();
          term.write(line);
        }
      } else if (data >= ' ' && !data.startsWith('\u001b')) {
        line += data;
        // Passwords are typed blind, as on a real console.
        if (!shell.masked) term.write(data);
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
