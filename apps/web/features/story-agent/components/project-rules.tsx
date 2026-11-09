"use client";

import { useState } from "react";
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from "@workspace/ui";
import type { StoryAgentProject, StoryAgentProjectRules } from "@workspace/types";
import type { createStoryAgentClient } from "../story-agent.client";
import { emptyProjectRules } from "../story-agent.projects";

const levels = ["initiative", "epic", "feature", "story", "task"] as const;
type Field<T> = Readonly<{ label: string; read: (item: T) => string; write: (item: T, value: string) => T; choices?: readonly string[] }>;
const Entries = <T,>({ label, items, fields, create, onChange }: Readonly<{ label: string; items: readonly T[]; fields: readonly Field<T>[]; create: () => T; onChange: (items: readonly T[]) => void }>): React.JSX.Element => <fieldset><legend>{label}</legend>
  {items.map((item, index) => <div className="forge-rule-row" key={index}>{fields.map((field) => <label key={field.label}>{field.label}{field.choices ? <Select value={field.read(item)} onValueChange={(value) => onChange(items.map((entry, i) => i === index ? field.write(entry, value) : entry))}><SelectTrigger aria-label={field.label}><SelectValue /></SelectTrigger><SelectContent>{field.choices.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select> : <Textarea value={field.read(item)} onChange={(event) => onChange(items.map((entry, i) => i === index ? field.write(entry, event.target.value) : entry))} />}</label>)}
    <Button variant="outline" disabled={index === 0} onClick={() => { const next = [...items]; const prior = next[index - 1]; if (prior !== undefined) { next[index - 1] = item; next[index] = prior; onChange(next); } }}>Move {label} {index + 1} up</Button>
    <Button variant="outline" onClick={() => onChange(items.filter((_, i) => i !== index))}>Delete {label} {index + 1}</Button>
  </div>)}<Button variant="outline" onClick={() => onChange([...items, create()])}>Add {label}</Button>
</fieldset>;

export const ProjectRules = ({ projects, selectedId, onSelect, onSaved, client, loadError }: Readonly<{ projects: readonly StoryAgentProject[]; selectedId: string; onSelect: (id: string) => void; onSaved: (project: StoryAgentProject) => void; client: ReturnType<typeof createStoryAgentClient>; loadError: string }>): React.JSX.Element => {
  const current = projects.find((project) => project.projectId === selectedId);
  return <section className="forge-project" aria-label="Project rules"><label>Project<Select value={selectedId || "none"} onValueChange={(id) => onSelect(id === "none" ? "" : id)}><SelectTrigger aria-label="Project for generation"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No project rules</SelectItem>{projects.map((project) => <SelectItem key={project.projectId} value={project.projectId}>{project.name}</SelectItem>)}</SelectContent></Select></label>{loadError ? <p role="alert">{loadError}</p> : null}<details><summary>Manage project rules</summary><RulesEditor key={current ? `${current.projectId}:${String(current.version)}` : "new"} current={current} client={client} onSaved={onSaved} /></details></section>;
};

const RulesEditor = ({ current, client, onSaved }: Readonly<{ current: StoryAgentProject | undefined; client: ReturnType<typeof createStoryAgentClient>; onSaved: (project: StoryAgentProject) => void }>): React.JSX.Element => {
  const [name, setName] = useState(current?.name ?? ""); const [rules, setRules] = useState<StoryAgentProjectRules>(current?.rules ?? emptyProjectRules());
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const save = async (): Promise<void> => {
    setBusy(true); setMessage("");
    try { const normalized = { ...rules, glossary: rules.glossary.map((term) => ({ ...term, aliases: term.aliases.map((alias) => alias.trim()).filter(Boolean) })) }; const project = await client.saveProject({ name: name.trim(), rules: normalized }, current); onSaved(project); setMessage("Project rules saved. Existing entries retain their saved rules version."); }
    catch (error: unknown) { setMessage(error instanceof Error ? error.message : "Project rules could not be saved."); }
    finally { setBusy(false); }
  };
  return <fieldset disabled={busy} className="forge-rules-editor"><label>Project name<Input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} /></label>
    <Entries label="glossary term" items={rules.glossary} create={() => ({ term: "", definition: "", aliases: [] })} onChange={(glossary) => setRules({ ...rules, glossary })} fields={[
      { label: "Term", read: (term) => term.term, write: (term, value) => ({ ...term, term: value }) },
      { label: "Definition", read: (term) => term.definition, write: (term, value) => ({ ...term, definition: value }) },
      { label: "Aliases (comma separated)", read: (term) => term.aliases.join(","), write: (term, value) => ({ ...term, aliases: value.split(",") }) }
    ]} />
    <Entries label="role" items={rules.roles} create={() => ({ name: "", description: "" })} onChange={(roles) => setRules({ ...rules, roles })} fields={[
      { label: "Role name", read: (role) => role.name, write: (role, value) => ({ ...role, name: value }) },
      { label: "Role definition", read: (role) => role.description, write: (role, value) => ({ ...role, description: value }) }
    ]} />
    <Entries label="naming convention" items={rules.naming} create={() => ({ level: levels.find((level) => !rules.naming.some((rule) => rule.level === level)) ?? "story", prefix: "", instructions: "Use a clear outcome title." })} onChange={(naming) => setRules({ ...rules, naming })} fields={[
      { label: "Hierarchy level", choices: levels, read: (rule) => rule.level, write: (rule, value) => ({ ...rule, level: levels.find((level) => level === value) ?? rule.level }) },
      { label: "Title prefix", read: (rule) => rule.prefix, write: (rule, value) => ({ ...rule, prefix: value }) },
      { label: "Naming instructions", read: (rule) => rule.instructions, write: (rule, value) => ({ ...rule, instructions: value }) }
    ]} />
    <fieldset><legend>Acceptance criteria</legend><Select value={rules.acceptanceCriteria.format} onValueChange={(format) => { if (format === "custom" || format === "checklist" || format === "given_when_then") setRules({ ...rules, acceptanceCriteria: { ...rules.acceptanceCriteria, format } }); }}><SelectTrigger aria-label="Acceptance criteria format"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="given_when_then">Given / When / Then</SelectItem><SelectItem value="checklist">Observable checklist</SelectItem><SelectItem value="custom">Project format</SelectItem></SelectContent></Select><label>Format instructions<Textarea value={rules.acceptanceCriteria.instructions} onChange={(event) => setRules({ ...rules, acceptanceCriteria: { ...rules.acceptanceCriteria, instructions: event.target.value } })} /></label>
    <Entries label="approved example" items={rules.acceptanceCriteria.examples} create={() => ""} onChange={(examples) => setRules({ ...rules, acceptanceCriteria: { ...rules.acceptanceCriteria, examples } })} fields={[{ label: "Example", read: (example) => example, write: (_example, value) => value }]} /></fieldset>
    <Entries label="project rule" items={rules.rules} create={() => ({ id: crypto.randomUUID(), group: "General", level: "all" as const, instruction: "", enabled: true })} onChange={(entries) => setRules({ ...rules, rules: entries })} fields={[
      { label: "Group", read: (rule) => rule.group, write: (rule, value) => ({ ...rule, group: value }) },
      { label: "Rule hierarchy level", choices: ["all", ...levels], read: (rule) => rule.level, write: (rule, value) => ({ ...rule, level: value === "all" ? "all" : levels.find((level) => level === value) ?? rule.level }) },
      { label: "Rule instruction", read: (rule) => rule.instruction, write: (rule, value) => ({ ...rule, instruction: value }) },
      { label: "Enabled", choices: ["yes", "no"], read: (rule) => rule.enabled ? "yes" : "no", write: (rule, value) => ({ ...rule, enabled: value === "yes" }) }
    ]} />
    <p>{JSON.stringify(rules).length} / 8000 configuration characters</p><Button disabled={busy || !name.trim() || JSON.stringify(rules).length > 8000} onClick={() => { void save(); }}>{busy ? "Saving…" : current ? "Save rules" : "Create project"}</Button><p role="status">{message}</p>
  </fieldset>;
};
