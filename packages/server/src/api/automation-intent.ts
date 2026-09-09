const AUTOMATION_CREATE_INTENT_PATTERN =
  /\b(?:create|make|set up|set-up|build|add|start|write|design)\b[^.!?\n]{0,80}\b(?:a|an|another|new)\b[^.!?\n]{0,80}\b(?:automation|workflow|scheduled task|recurring task)\b|\b(?:want|need)\b[^.!?\n]{0,40}\b(?:a|an|new)\b[^.!?\n]{0,40}\b(?:automation|workflow|scheduled task)\b|\b(?:remind me to|set a reminder|create a reminder|make a reminder)\b/i;

const AUTOMATION_UPDATE_INTENT_PATTERN =
  /\b(?:update|edit|change|modify|adjust|fix|improve|remove|delete|pause|resume|stop|disable|enable|rename|alter)\b[^.!?\n]{0,180}\b(?:automation|workflow|scheduled task)\b|\badd\b[^.!?\n]{0,120}\b(?:my|our|the|this|that|their)\b[^.!?\n]{0,60}\b(?:automation|workflow|scheduled task)\b/i;

export function hasAutomationCreateIntent(message: string): boolean {
  if (AUTOMATION_UPDATE_INTENT_PATTERN.test(message)) return false;
  return message.split(/[.!?;\n]|\bbut\b|\binstead\b/i).some((clause) => {
    const match = AUTOMATION_CREATE_INTENT_PATTERN.exec(clause);
    if (!match) return false;
    const prefix = clause.slice(0, match.index).replace(/’/g, "'");
    return !/\b(?:do not|don't|does not|doesn't|never|avoid|without|not to)\b/i.test(prefix);
  });
}

export function hasAutomationUpdateIntent(message: string): boolean {
  return AUTOMATION_UPDATE_INTENT_PATTERN.test(message);
}
