import type { StoryAgentArtifactLevel, StoryAgentPlan, StoryAgentQualityCheck, StoryAgentQualityReport } from "@workspace/types";
import type { StoryAgentProjectRules } from "@workspace/types";

export type StoryAgentArtifact = Readonly<{ path: string; level: StoryAgentArtifactLevel; title: string; text: string; criteria?: readonly string[] }>;

export const planArtifacts = (plan: StoryAgentPlan): readonly StoryAgentArtifact[] => {
  const items: StoryAgentArtifact[] = [{ path: "initiative", level: "initiative", title: plan.initiative.title, text: plan.initiative.outcome }];
  plan.initiative.epics.forEach((epic, e) => {
    const ep = `initiative.epics.${String(e)}`;
    items.push({ path: ep, level: "epic", title: epic.title, text: epic.objective });
    epic.features.forEach((feature, f) => {
      const fp = `${ep}.features.${String(f)}`;
      items.push({ path: fp, level: "feature", title: feature.title, text: feature.outcome });
      feature.stories.forEach((story, s) => {
        const sp = `${fp}.stories.${String(s)}`;
        items.push({ path: sp, level: "story", title: story.title, text: story.intent, criteria: story.acceptanceCriteria });
        story.tasks.forEach((task, t) => items.push({ path: `${sp}.tasks.${String(t)}`, level: "task", title: task.title, text: task.description }));
      });
    });
  });
  return items;
};

const normalize = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Blocking status comes exclusively from the existing generation validators.
// Heuristics below are advisory and must not claim semantic verification.
export const explainQuality = (plan: StoryAgentPlan | undefined, validationErrors: readonly string[], projectRules?: StoryAgentProjectRules): StoryAgentQualityReport => {
  const checks: StoryAgentQualityCheck[] = validationErrors.map((error) => ({
    artifactPath: "initiative", level: "initiative", dimension: /Duplicate/.test(error) ? "duplicate_behavior" : /At most/.test(error) ? "scope" : "completeness",
    status: "failed", issue: error, reason: "The existing output validator rejected this output.",
    impact: "The output cannot be safely saved as a usable draft.",
    suggestedFix: /Duplicate/.test(error) ? "Remove the overlapping story or give it a distinct user outcome and title." : /At most/.test(error) ? "Keep the highest-value stories within the configured story limit." : "Supply the required field at the reported path using the expected type and limits."
  }));
  const artifacts = plan ? planArtifacts(plan) : [];
  for (const artifact of artifacts) {
    const add = (dimension: StoryAgentQualityCheck["dimension"], status: StoryAgentQualityCheck["status"], issue: string, reason: string, impact: string, suggestedFix: string): void => {
      checks.push({ artifactPath: artifact.path, level: artifact.level, dimension, status, issue, reason, impact, suggestedFix });
    };
    add("completeness", "passed", "Required artifact fields are present.", `The ${artifact.level} satisfies its own hierarchy schema.`, "Consumers can read its required fields and relationships.", "Keep these fields when refining the artifact.");
    const naming = projectRules?.naming.find((rule) => rule.level === artifact.level);
    if (naming) add("ambiguity", naming.prefix && !artifact.title.startsWith(naming.prefix) ? "warning" : "needs_review", "Review project naming convention.", `Expected prefix: ${naming.prefix || "none"}. ${naming.instructions}`, "Inconsistent names make the project hierarchy harder to navigate.", "Apply the configured naming convention without changing the artifact's meaning.");
    for (const rule of projectRules?.rules.filter((rule) => rule.enabled && (rule.level === "all" || rule.level === artifact.level)) ?? []) add("completeness", "needs_review", `Project rule (${rule.group})`, rule.instruction, "A project convention may be unmet; semantic compliance needs review.", "Compare the artifact with this rule and request an explicit refinement when needed.");
    if (artifact.level === "story" && projectRules) add("testability", projectRules.acceptanceCriteria.format === "given_when_then" && !artifact.criteria?.every((criterion) => /given.+when.+then/is.test(criterion)) ? "warning" : "needs_review", "Review project acceptance criteria format.", `${projectRules.acceptanceCriteria.format}: ${projectRules.acceptanceCriteria.instructions}`, "Criteria may differ from the project's approved review format.", "Use the project format and approved examples while retaining the story's actual requirements.");
    const vague = /\b(etc|somehow|appropriate|user.friendly|as needed|fast|seamless|various|TBD)\b/i.test(`${artifact.title} ${artifact.text} ${artifact.criteria?.join(" ") ?? ""}`);
    add("ambiguity", vague ? "warning" : "needs_review", vague ? "Unbounded or vague wording needs clarification." : "Review wording for shared understanding.", vague ? "The text includes wording without an observable definition." : "A wording scan cannot establish that stakeholders interpret the text identically.", "Different interpretations can lead to inconsistent delivery.", artifact.level === "task" ? "Name the implementation result and how to verify it; replace vague terms with explicit conditions." : "Replace subjective terms with observable outcomes or agreed thresholds without inventing requirements.");
    add("scope", "needs_review", `Review the ${artifact.level}'s scope.`, artifact.level === "story" ? "Each story should serve one actor and one outcome." : artifact.level === "task" ? "A task should describe one implementable piece of its parent story." : "This planning level groups outcomes and may legitimately contain multiple children.", "Unclear boundaries make estimation and delivery harder.", artifact.level === "story" ? "Split distinct actor outcomes into independent stories." : artifact.level === "task" ? "Limit the task to one verifiable implementation result." : "Clarify the boundary and move unrelated child outcomes to a separate group.");
    if (artifact.level === "story") {
      const observable = artifact.criteria?.every((criterion) => /\b(given|when|then)\b/i.test(criterion));
      add("testability", observable ? "needs_review" : "warning", observable ? "Verify acceptance criteria describe observable results." : "Acceptance criteria need explicit conditions and results.", observable ? "Scenario wording is present but does not prove correctness or measurability." : "Criteria lack explicit scenario wording; this is advisory, not a required syntax.", "Acceptance may be subjective or miss failure paths.", "State a precondition, action, and observable result for each behavior, including relevant failure paths.");
      add("independence", "needs_review", "Review delivery dependencies.", "The hierarchy schema does not encode enough dependency evidence to prove independence.", "Hidden dependencies may block a story from shipping.", "Identify prerequisites and split the story so its user outcome can be verified independently.");
    } else if (artifact.level === "task") {
      add("testability", "needs_review", "Review the task's verification step.", "Task descriptions, rather than story acceptance criteria, define implementation work.", "Completion can be difficult to verify.", "Specify the concrete output and a check demonstrating that it supports the parent story.");
    }
    const duplicate = artifacts.some((other) => other.path !== artifact.path && other.level === artifact.level && normalize(other.title) === normalize(artifact.title));
    add("duplicate_behavior", duplicate ? "warning" : "needs_review", duplicate ? "Another artifact at this level has the same normalized title." : "Review overlap with related artifacts.", duplicate ? "Matching titles can indicate repeated responsibility; repeated task titles can also be legitimate." : "Distinct titles alone do not prove distinct behavior.", "Repeated responsibilities can cause duplicate implementation.", "Compare the outcomes and parent context; merge overlapping work or clarify distinct responsibilities.");
    add("requirement_coverage", "needs_review", "Confirm coverage against the original requirement.", "Deterministic structural checks cannot establish semantic coverage or detect every invented requirement.", "Requested behavior could be omitted or unsupported scope could be added.", "Compare this outcome and its children with the original brief; identify missing behavior or remove unsupported additions.");
  }
  return { status: validationErrors.length ? "failed" : "passed", checks };
};
