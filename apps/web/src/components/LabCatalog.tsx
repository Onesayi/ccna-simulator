import { DOMAINS, LABS, summarise, type DomainId, type LabDefinition, type LabProgress } from '@ccna-sim/engine';
import { useStudy } from '../state/study';

const KIND_LABEL: Record<LabDefinition['kind'], string> = { guided: 'Guided', troubleshoot: 'Troubleshoot', challenge: 'Challenge' };

export function Difficulty({ level }: { level: 1 | 2 | 3 }) {
  return (
    <span className="difficulty" aria-label={`Difficulty ${level} of 3`} title={`Difficulty ${level} of 3`}>
      {[1, 2, 3].map((n) => (
        <i key={n} className={n <= level ? 'on' : ''} />
      ))}
    </span>
  );
}

function status(p: LabProgress | undefined): { label: string; className: string } {
  if (p?.completedAt) return { label: 'Done', className: 'done' };
  if (p) return { label: 'Started', className: 'started' };
  return { label: 'New', className: 'new' };
}

function Bar({ done, total }: { done: number; total: number }) {
  return (
    <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
      <div style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
    </div>
  );
}

/** The lab picker: every lab grouped by blueprint domain, with completion from local progress. */
export function LabCatalog({ onOpen }: { onOpen: (labId: string) => void }) {
  const { progress, forgetProgress } = useStudy();
  const summary = summarise(progress, LABS);
  const done = summary.reduce((n, s) => n + s.done, 0);
  const planned = (Object.keys(DOMAINS) as DomainId[]).filter((d) => !summary.some((s) => s.domain === d));

  return (
    <div className="lab-catalog">
      <div className="catalog-head">
        <div>
          <h2>Study labs</h2>
          <p className="muted">
            Hands-on labs mapped to the CCNA 200-301 v2.0 blueprint. Each one is graded against the live network, and your progress is saved in this browser.
          </p>
        </div>
        <div className="overall">
          <strong>
            {done} of {LABS.length}
          </strong>{' '}
          labs complete
          <Bar done={done} total={LABS.length} />
        </div>
      </div>

      {summary.map((s) => (
        <section key={s.domain} className="domain">
          <div className="domain-head">
            <h3>
              {s.domain} {s.name}
            </h3>
            <span className="muted">
              {s.done}/{s.total}
            </span>
            <Bar done={s.done} total={s.total} />
          </div>
          <div className="cards">
            {LABS.filter((l) => l.domain === s.domain).map((lab) => {
              const st = status(progress[lab.id]);
              return (
                <button key={lab.id} className={`card ${st.className}`} onClick={() => onOpen(lab.id)}>
                  <span className="card-top">
                    <span className={`kind ${lab.kind}`}>{KIND_LABEL[lab.kind]}</span>
                    <Difficulty level={lab.difficulty} />
                    <span className={`status ${st.className}`}>{st.label}</span>
                  </span>
                  <span className="card-title">{lab.title}</span>
                  <span className="card-summary">{lab.summary}</span>
                  <span className="tags">
                    {lab.blueprint.map((b) => (
                      <span key={b} className="tag">
                        {b}
                      </span>
                    ))}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}

      {planned.length > 0 && (
        <p className="muted planned">
          Still to come: labs for {planned.map((d) => `${d} ${DOMAINS[d]}`).join(' and ')}. They arrive as the engine learns ACLs, NAT, DHCP, port security and more.
        </p>
      )}
      {done > 0 || Object.keys(progress).length > 0 ? (
        <p>
          <button className="link" onClick={() => window.confirm('Forget all lab progress saved in this browser?') && forgetProgress()}>
            Reset all progress
          </button>
        </p>
      ) : null}
    </div>
  );
}
