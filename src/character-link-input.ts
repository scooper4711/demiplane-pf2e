const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEMIPLANE_URL_PREFIX =
  "https://app.demiplane.com/nexus/pathfinder2e/character-sheet/";

export type CharacterLinkParseResult =
  | { valid: true; uuid: string }
  | { valid: false; error: string };

export function parseCharacterLinkInput(
  input: string,
): CharacterLinkParseResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return {
      valid: false,
      error:
        "Input is empty. Please provide a Demiplane character UUID or URL.",
    };
  }

  let candidate: string;

  if (trimmed.toLowerCase().startsWith(DEMIPLANE_URL_PREFIX.toLowerCase())) {
    candidate = trimmed.slice(DEMIPLANE_URL_PREFIX.length);
  } else {
    candidate = trimmed;
  }

  if (UUID_PATTERN.test(candidate)) {
    return { valid: true, uuid: candidate.toLowerCase() };
  }

  return {
    valid: false,
    error: `Input is neither a valid UUID nor a recognized Demiplane character URL. Expected formats: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" or "${DEMIPLANE_URL_PREFIX}xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"`,
  };
}
