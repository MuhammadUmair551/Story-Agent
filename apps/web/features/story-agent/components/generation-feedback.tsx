import type { StoryAgentRun } from "../story-agent.types";

export const GenerationFeedback = ({ run }: Readonly<{ run: StoryAgentRun }>): React.JSX.Element | null => {
  if (run.status === "draft" || run.status === "questions") return null;
  const diagnostic = run.diagnostic;
  return <section className="forge-generation-feedback" aria-label="Generation status">
    <h3>{run.status === "queued" ? "Saved generation" : "Generation could not complete"}</h3>
    <p>{run.status === "queued" ? "This run is saved and will update automatically. You do not need to submit it again." : "No usable delivery plan was produced. Quality review and refinement are unavailable for this attempt."}</p>
    {run.runId ? <p>Saved attempt: <code>{run.runId}</code>. Open it again from Story vault.</p> : null}
    {diagnostic ? <details><summary>Generation diagnostics</summary><dl>
      <dt>Reason</dt><dd>{diagnostic.reason}</dd><dt>Stage</dt><dd>{diagnostic.stage}</dd>
      <dt>Recovery</dt><dd>{run.status === "queued" && diagnostic.retryable ? "Automatic retry is scheduled." : "No automatic retry is pending."}</dd>
      {diagnostic.httpStatus ? <><dt>HTTP status</dt><dd>{diagnostic.httpStatus}</dd></> : null}
      {diagnostic.provider ? <><dt>Provider</dt><dd>{diagnostic.provider}{diagnostic.model ? ` / ${diagnostic.model}` : ""}</dd></> : null}
    </dl>{diagnostic.issues?.map((issue, index) => <p key={`${issue.path}-${String(index)}`}>{issue.path || "Response"}: {issue.message}</p>)}</details> : null}
  </section>;
};
