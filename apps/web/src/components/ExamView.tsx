import { useEffect, useState } from 'react';
import { DOMAINS, EXAM_LENGTHS, PASS_SCORE, SECONDS_PER_QUESTION, findLab, labsToPractise, type DomainId } from '@ccna-sim/engine';
import { useExam } from '../state/exam';

const DOMAIN_IDS = Object.keys(DOMAINS) as DomainId[];

function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function Bar({ value, total, pass }: { value: number; total: number; pass?: boolean }) {
  return (
    <div className={`bar ${pass === false ? 'low' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={value}>
      <div style={{ width: `${total ? (value / total) * 100 : 0}%` }} />
    </div>
  );
}

function LabLinks({ labs }: { labs: string[] }) {
  if (!labs.length) return null;
  return (
    <span className="lab-links">
      Practise in{' '}
      {labs.map((id, i) => (
        <span key={id}>
          {i > 0 && ', '}
          <a href={`#/labs/${id}`}>{findLab(id)?.title ?? id}</a>
        </span>
      ))}
    </span>
  );
}

function Setup() {
  const { start, history, clearHistory } = useExam();
  const [length, setLength] = useState<number>(EXAM_LENGTHS[0].questions);
  const [domain, setDomain] = useState<DomainId | ''>('');

  return (
    <div className="exam-setup">
      <h2>Practice exam</h2>
      <p className="muted">
        Timed multiple-choice questions written from the CCNA 200-301 v2.0 topics, drawn in the same proportions as the real exam. You get {SECONDS_PER_QUESTION} seconds a
        question, the real exam&rsquo;s pace. Results are scored out of 1000 and broken down by domain, with a lab to practise for every question you miss.
      </p>

      <fieldset className="choice">
        <legend>Length</legend>
        {EXAM_LENGTHS.map((l) => (
          <label key={l.id} className={length === l.questions ? 'on' : ''}>
            <input type="radio" name="length" checked={length === l.questions} onChange={() => setLength(l.questions)} />
            <strong>{l.label}</strong>
            <span className="muted">
              {l.questions} questions, {Math.round((l.questions * SECONDS_PER_QUESTION) / 60)} minutes
            </span>
          </label>
        ))}
      </fieldset>

      <label className="domain-pick">
        Domains{' '}
        <select value={domain} onChange={(e) => setDomain(e.target.value as DomainId | '')}>
          <option value="">All five, weighted like the exam</option>
          {DOMAIN_IDS.map((d) => (
            <option key={d} value={d}>
              {d} {DOMAINS[d]} only
            </option>
          ))}
        </select>
      </label>

      <p>
        <button className="primary" onClick={() => start({ questions: length, domain: domain || undefined })}>
          Start exam
        </button>
      </p>

      {history.length > 0 && (
        <section className="exam-history">
          <h3>Recent attempts</h3>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Questions</th>
                <th>Score</th>
                {DOMAIN_IDS.map((d) => (
                  <th key={d} title={DOMAINS[d]}>
                    {d}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.map((a) => (
                <tr key={a.at}>
                  <td>{new Date(a.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                  <td>
                    {a.total}
                    {a.domain ? ` (${a.domain})` : ''}
                  </td>
                  <td className={a.score >= PASS_SCORE ? 'pass' : 'fail'}>{a.score}</td>
                  {DOMAIN_IDS.map((d) => {
                    const s = a.domains.find((x) => x.domain === d);
                    return <td key={d}>{s ? `${Math.round((s.correct / s.total) * 100)}%` : '–'}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <button className="link" onClick={() => window.confirm('Forget all exam attempts saved in this browser?') && clearHistory()}>
            Clear history
          </button>
        </section>
      )}
    </div>
  );
}

function Running() {
  const { exam, answers, flagged, current, startedAt, choose, toggleFlag, goTo, finish, leave } = useExam();
  const [now, setNow] = useState(() => Date.now());
  const left = exam ? exam.seconds - (now - startedAt) / 1000 : 0;

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    if (left <= 0) finish();
  }, [left, finish]);

  if (!exam) return null;
  const item = exam.items[current]!;
  const chosen = answers[current] ?? [];
  const multi = item.answer.length > 1;
  const answered = exam.items.filter((_, i) => (answers[i]?.length ?? 0) > 0).length;
  const last = current === exam.items.length - 1;

  const submit = () => {
    const blank = exam.items.length - answered;
    const msg = blank ? `${blank} question${blank === 1 ? ' is' : 's are'} unanswered and will be marked wrong. Finish the exam?` : 'Finish the exam and see your score?';
    if (window.confirm(msg)) finish();
  };

  return (
    <div className="exam-run">
      <div className="exam-bar">
        <span>
          Question <strong>{current + 1}</strong> of {exam.items.length}
        </span>
        <span className="muted">{answered} answered</span>
        <span className={`timer ${left < 300 ? 'low' : ''}`} role="timer" aria-label="Time left">
          {clock(left)}
        </span>
        <button onClick={submit}>Finish exam</button>
        <button className="link" onClick={() => window.confirm('Abandon this exam? It will not be scored.') && leave()}>
          Abandon
        </button>
      </div>

      <div className="exam-body">
        <article className="question-card">
          <p className="prompt">{item.question.prompt}</p>
          {item.question.exhibit && <pre className="exhibit">{item.question.exhibit}</pre>}
          {multi && <p className="muted small">Choose {item.answer.length}.</p>}
          <div className="options" role={multi ? 'group' : 'radiogroup'} aria-label="Answers">
            {item.options.map((opt, o) => (
              <label key={o} className={chosen.includes(o) ? 'on' : ''}>
                <input type={multi ? 'checkbox' : 'radio'} name={`exam-q${current}`} checked={chosen.includes(o)} onChange={() => choose(current, o)} />
                <span>{opt}</span>
              </label>
            ))}
          </div>
          <div className="question-nav">
            <button onClick={() => goTo(current - 1)} disabled={current === 0}>
              Previous
            </button>
            <button aria-pressed={flagged.has(current)} className={flagged.has(current) ? 'flag on' : 'flag'} onClick={() => toggleFlag(current)}>
              {flagged.has(current) ? 'Flagged' : 'Flag for review'}
            </button>
            {last ? (
              <button className="primary" onClick={submit}>
                Finish exam
              </button>
            ) : (
              <button className="primary" onClick={() => goTo(current + 1)}>
                Next
              </button>
            )}
          </div>
        </article>

        <nav className="question-grid" aria-label="Questions">
          {exam.items.map((_, i) => (
            <button
              key={i}
              className={[i === current ? 'current' : '', (answers[i]?.length ?? 0) > 0 ? 'answered' : '', flagged.has(i) ? 'flagged' : ''].join(' ')}
              aria-current={i === current}
              onClick={() => goTo(i)}
            >
              {i + 1}
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}

function Results() {
  const { exam, answers, result, startedAt, finishedAt, start, leave } = useExam();
  const [all, setAll] = useState(false);
  if (!exam || !result) return null;
  const practise = labsToPractise(exam, result.missed);
  const shown = all ? exam.items.map((_, i) => i) : result.missed;
  const took = Math.min(exam.seconds, ((finishedAt ?? startedAt) - startedAt) / 1000);

  return (
    <div className="exam-results">
      <div className={`score-card ${result.passed ? 'pass' : 'fail'}`} role="status">
        <div className="score">
          <strong>{result.score}</strong> / 1000
        </div>
        <div>
          <div className="verdict">{result.passed ? 'Pass' : 'Not yet'}</div>
          <div className="muted small">
            {result.correct} of {result.total} correct in {clock(took)}. The practice pass mark is {PASS_SCORE}; Cisco does not publish the real one.
          </div>
        </div>
        <div className="actions">
          <button onClick={() => start({ questions: exam.items.length, domain: exam.domain, seed: exam.seed })}>Retake these questions</button>
          <button className="primary" onClick={leave}>
            New exam
          </button>
        </div>
      </div>

      <section>
        <h3>By domain</h3>
        <table className="domain-scores">
          <tbody>
            {result.domains.map((d) => {
              const pct = Math.round((d.correct / d.total) * 100);
              return (
                <tr key={d.domain}>
                  <th>
                    {d.domain} {d.name}
                  </th>
                  <td>
                    {d.correct}/{d.total}
                  </td>
                  <td className="pct">{pct}%</td>
                  <td className="bar-cell">
                    <Bar value={d.correct} total={d.total} pass={pct * 10 >= PASS_SCORE} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {practise.length > 0 && (
        <section className="practise">
          <h3>Labs to practise</h3>
          <ul>
            {practise.slice(0, 6).map((p) => (
              <li key={p.lab}>
                <a href={`#/labs/${p.lab}`}>{findLab(p.lab)?.title ?? p.lab}</a>{' '}
                <span className="muted small">
                  {p.missed} missed question{p.missed === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="review">
        <div className="review-head">
          <h3>{all ? 'All questions' : result.missed.length ? 'Questions you missed' : 'No questions missed'}</h3>
          <label className="small">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show all questions
          </label>
        </div>
        <ol>
          {shown.map((i) => {
            const item = exam.items[i]!;
            const mine = answers[i] ?? [];
            const right = !result.missed.includes(i);
            return (
              <li key={i} value={i + 1} className={`review-item ${right ? 'right' : 'wrong'}`}>
                <p className="prompt">{item.question.prompt}</p>
                {item.question.exhibit && <pre className="exhibit">{item.question.exhibit}</pre>}
                <ul className="review-options">
                  {item.options.map((opt, o) => (
                    <li key={o} className={[item.answer.includes(o) ? 'correct' : '', mine.includes(o) ? 'chosen' : ''].join(' ')}>
                      {opt}
                      {mine.includes(o) && <span className="muted small"> (your answer)</span>}
                    </li>
                  ))}
                </ul>
                {mine.length === 0 && <p className="muted small">Not answered.</p>}
                <p className="explain">{item.question.explain}</p>
                <p className="small">
                  <span className="tag">{item.question.objective}</span> <LabLinks labs={item.question.labs ?? []} />
                </p>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

/** The practice exam: pick a length, answer against the clock, then review the score by domain. */
export function ExamView() {
  const { exam, result } = useExam();
  return <div className="exam-page">{!exam ? <Setup /> : result ? <Results /> : <Running />}</div>;
}
