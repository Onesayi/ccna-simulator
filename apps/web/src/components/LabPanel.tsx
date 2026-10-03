import { DOMAINS, LABS, PROBE_CHECKS, type ObjectiveResult } from '@ccna-sim/engine';
import { useStudy } from '../state/study';
import { Difficulty } from './LabCatalog';
import { Inline, RichText } from './RichText';

const ICON: Record<ObjectiveResult['status'], string> = { pass: '✓', fail: '✗', untested: '○' };

function Objective({ result, index }: { result: ObjectiveResult; index: number }) {
  const { hints, revealHint, answer, run } = useStudy();
  const { objective, status, detail } = result;
  const { check } = objective;
  const isProbe = PROBE_CHECKS.includes(check.type);

  if (check.type === 'quiz') {
    const chosen = run?.answers.get(index);
    return (
      <li className={`objective quiz ${status}`}>
        <span className="mark" aria-label={status}>
          {ICON[status]}
        </span>
        <div>
          <div className="quiz-label">{objective.text}</div>
          <div className="question">
            <Inline text={check.question} />
          </div>
          <div className="options" role="radiogroup">
            {check.options.map((opt, o) => (
              <label key={o} className={chosen === o ? (o === check.answer ? 'right' : 'wrong') : ''}>
                <input type="radio" name={`q${index}`} checked={chosen === o} onChange={() => answer(index, o)} /> <Inline text={opt} />
              </label>
            ))}
          </div>
          {status === 'fail' && <div className="detail">{detail}</div>}
          {status === 'pass' && check.explain && (
            <div className="explain">
              <Inline text={check.explain} />
            </div>
          )}
        </div>
      </li>
    );
  }

  return (
    <li className={`objective ${status}`}>
      <span className="mark" aria-label={status}>
        {ICON[status]}
      </span>
      <div>
        <Inline text={objective.text} />
        {status === 'fail' && detail && <div className="detail">{detail}</div>}
        {status === 'untested' && isProbe && <div className="detail muted">Tested when you press Check my work.</div>}
        {objective.hint && status !== 'pass' && (
          hints.has(index) ? (
            <div className="hint">
              <Inline text={objective.hint} />
            </div>
          ) : (
            <button className="link" onClick={() => revealHint(index)}>
              Show hint
            </button>
          )
        )}
      </div>
    </li>
  );
}

/** The lab sheet beside the canvas: briefing, live objectives, hints, check, reset and solution. */
export function LabPanel({ onBack, onOpen }: { onBack: () => void; onOpen: (labId: string) => void }) {
  const { run, results, completed, progress, showSolution, check, reset, revealSolution } = useStudy();
  if (!run) return null;
  const { lab } = run;
  const p = progress[lab.id];
  const passed = results.filter((r) => r.status === 'pass').length;
  const next = LABS[LABS.findIndex((l) => l.id === lab.id) + 1];

  return (
    <div className="lab-sheet">
      <button className="link back" onClick={onBack}>
        ← All labs
      </button>
      <h2>{lab.title}</h2>
      <div className="lab-meta">
        <span className="tag" title={DOMAINS[lab.domain]}>
          {lab.domain} {DOMAINS[lab.domain]}
        </span>
        {lab.blueprint.map((b) => (
          <span key={b} className="tag">
            {b}
          </span>
        ))}
        <Difficulty level={lab.difficulty} />
      </div>

      <div className="briefing">
        <RichText text={lab.briefing} />
      </div>

      {lab.addressing && (
        <table className="addressing">
          <thead>
            <tr>
              <th>Device</th>
              <th>Interface</th>
              <th>Address</th>
              <th>Gateway</th>
            </tr>
          </thead>
          <tbody>
            {lab.addressing.map((row, i) => (
              <tr key={i}>
                <td>{row.device}</td>
                <td>{row.interface}</td>
                <td>
                  {row.address}
                  {row.note && <small> {row.note}</small>}
                </td>
                <td>{row.gateway ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>
        Objectives <span className="muted">
          {passed}/{results.length}
        </span>
      </h3>
      <ol className="objectives">
        {results.map((r, i) => (
          <Objective key={i} result={r} index={i} />
        ))}
      </ol>

      {completed && (
        <div className="complete" role="status">
          <strong>Lab complete.</strong>
          {lab.debrief && (
            <p>
              <Inline text={lab.debrief} />
            </p>
          )}
          {next && <button onClick={() => onOpen(next.id)}>Next lab: {next.title} →</button>}
        </div>
      )}

      <div className="lab-actions">
        <button className="primary" onClick={check}>
          Check my work
        </button>
        <button onClick={() => window.confirm('Reset this lab to its starting configuration?') && reset()}>Reset lab</button>
        {!showSolution && (
          <button className="link" onClick={() => window.confirm('Show the model answer?') && revealSolution()}>
            Show solution
          </button>
        )}
      </div>
      {p && (
        <p className="muted small">
          {p.completedAt ? `Completed ${new Date(p.completedAt).toLocaleDateString()}. ` : ''}
          Checked {p.checks} {p.checks === 1 ? 'time' : 'times'}, {p.hintsUsed} {p.hintsUsed === 1 ? 'hint' : 'hints'} used.
        </p>
      )}

      {showSolution && (
        <div className="solution">
          <h3>Solution</h3>
          {Object.entries(lab.solution).map(([device, commands]) => (
            <div key={device}>
              <div className="solution-device">{device}</div>
              <pre>{commands.trim().split('\n').map((l) => l.trim()).join('\n')}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
