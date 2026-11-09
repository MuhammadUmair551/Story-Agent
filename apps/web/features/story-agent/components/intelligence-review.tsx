"use client";

import { useState } from "react";
import { Button, Checkbox, Textarea } from "@workspace/ui";
import type { StoryAgentRun } from "../story-agent.types";
import type { createStoryAgentClient } from "../story-agent.client";
import { comparisonCandidates, comparisonSelectionLimit, updateComparisonSelection } from "../story-agent.comparisons";
import { IntelligenceFindings } from "./intelligence-findings";

export const IntelligenceReview = ({ run, client, onUpdated }: Readonly<{ run: StoryAgentRun; client: ReturnType<typeof createStoryAgentClient>; onUpdated: (run: StoryAgentRun) => void }>): React.JSX.Element => {
  const [updatedRequirement, setUpdatedRequirement] = useState(run.requirement);
  const [candidates, setCandidates] = useState<readonly StoryAgentRun[]>([]);
  const [comparisons, setComparisons] = useState<readonly string[]>([]);
  const [explicitScope, setExplicitScope] = useState(false);
  const [nextSkip, setNextSkip] = useState(0); const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const pending = run.refinements?.some((proposal) => proposal.status === "pending");
  const perform = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setMessage(""); let saved = false;
    try { await operation(); saved = true; const detail = await client.getRun(run.runId); onUpdated(detail.run); setMessage("Review saved. Artifacts change only after you accept a refinement proposal."); }
    catch (error: unknown) { setMessage(saved ? "Request saved, but reload failed. Use Reload saved entry before continuing." : error instanceof Error ? error.message : "Analysis could not be completed."); }
    finally { setBusy(false); }
  };
  const loadComparisons = async (reset = true): Promise<void> => {
    setBusy(true); setMessage("");
    try {
      const page = await client.listComparisons(run.runId, reset ? 0 : nextSkip);
      const selected = reset ? await Promise.all(comparisons.map(async (id) => {
        try { return (await client.getRun(id)).run; } catch (error: unknown) { if (typeof error === "object" && error !== null && "status" in error && error.status === 404) return undefined; throw error; }
      })) : [];
      const items = comparisonCandidates(run, [...(reset ? selected.filter((item): item is StoryAgentRun => item !== undefined) : candidates), ...page.runs]);
      const retained = comparisons.filter((id) => items.some((item) => item.runId === id));
      setCandidates(items); setComparisons(retained); setExplicitScope(true);
      setNextSkip(page.nextSkip); setHasMore(page.hasMore);
      setMessage(retained.length < comparisons.length ? "Unavailable selections were removed. The comparison scope remains your explicit selection." : "Choose saved entries by title. Pages contain up to 100 available drafts in the same project. Load more to reach older entries.");
    } catch (error: unknown) { setMessage(error instanceof Error ? error.message : "Saved entries could not be loaded. Your previous selection is retained."); }
    finally { setBusy(false); }
  };
  const analyze = (kind: "backlog" | "impact"): void => { void perform(() => client.analyzeRun(run.runId, { kind, version: run.refinementVersion ?? 0, ...(kind === "impact" ? { updatedRequirement: updatedRequirement.trim() } : { evidenceVersion: 2 as const }), ...(explicitScope ? { compareRunIds: comparisons } : {}) })); };
  return <section className="forge-intelligence" aria-label="Backlog intelligence"><h3>Backlog intelligence</h3><p>Review duplicates, contradictory requirements and terminology. Findings require human review and do not prove complete semantic coverage.</p>
    <p>{run.projectId ? "Automatic scope compares saved drafts in this project." : "Automatic scope reviews only this hierarchy. You can select other saved entries without a project."} The report lists the exact comparison scope.</p>
    <Button variant="outline" disabled={busy || pending} onClick={() => { void loadComparisons(); }}>{explicitScope ? "Refresh saved comparison entries" : "Choose saved comparison entries"}</Button>
    {explicitScope ? <fieldset disabled={busy || pending} className="forge-comparisons"><legend>Selected comparisons: {comparisons.length} / {comparisonSelectionLimit}</legend><p>An empty selection reviews only this hierarchy.</p>{candidates.length ? candidates.map((item) => <label key={item.runId}><Checkbox aria-label={`Compare saved entry: ${item.requirement || "Untitled story"} (${item.runId})`} checked={comparisons.includes(item.runId)} disabled={busy || pending || (comparisons.length >= comparisonSelectionLimit && !comparisons.includes(item.runId))} onCheckedChange={(checked) => setComparisons((selected) => updateComparisonSelection(selected, item.runId, checked === true, candidates))} /><span>{item.requirement || "Untitled story"}<small>{item.createdAt ?? "Saved entry"} · {item.runId}</small></span></label>) : <p>No eligible comparison entries.</p>}{hasMore ? <Button variant="outline" onClick={() => { void loadComparisons(false); }}>Load more comparison entries</Button> : <p>All available comparison entries have been loaded.</p>}<Button variant="outline" onClick={() => setExplicitScope(false)}>Use automatic comparison scope</Button></fieldset> : null}
    <Button disabled={busy || pending} onClick={() => analyze("backlog")}>Review backlog</Button><label>Updated requirement<Textarea maxLength={4000} value={updatedRequirement} onChange={(event) => setUpdatedRequirement(event.target.value)} disabled={busy} /></label>
    <Button disabled={busy || pending || !updatedRequirement.trim() || updatedRequirement.trim() === run.requirement} onClick={() => analyze("impact")}>Analyze requirement change</Button><p role="status">{message}</p>
    {[...(run.analyses ?? [])].reverse().map((analysis) => <details key={analysis.id}><summary>{analysis.kind === "impact" ? "Requirement impact" : "Backlog review"} · {analysis.createdAt}</summary><p>Source entry: {run.runId}. Compared entries: {analysis.compared.map((item) => item.runId).join(", ") || "none"}.</p><h4>Original requirement</h4><p>{analysis.originalRequirement}</p>{analysis.updatedRequirement ? <><h4>Updated requirement</h4><p>{analysis.updatedRequirement}</p><p>Each accepted proposal updates only the selected subtree and the reviewed requirement. Review remaining artifacts and rerun analysis after an acceptance.</p></> : null}
      <IntelligenceFindings run={run} analysis={analysis} client={client} busy={busy} perform={perform} />
    </details>)}
  </section>;
};
