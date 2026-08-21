#!/usr/bin/env bash
#
# Determines the next semantic version based on conventional commits
# since the last tag, then creates and pushes the tag to trigger
# the draft-release workflow.
#
# Usage:
#   ./scripts-build/release.sh           # auto-detect bump type
#   ./scripts-build/release.sh patch     # force patch bump
#   ./scripts-build/release.sh minor     # force minor bump
#   ./scripts-build/release.sh major     # force major bump
#   ./scripts-build/release.sh beta      # beta pre-release (auto-detect bump)
#   ./scripts-build/release.sh beta major # beta pre-release (force major bump)
#
set -euo pipefail

# Abort if the working tree is dirty
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: Working tree is not clean. Commit or stash changes before releasing."
  exit 1
fi

IS_BETA=false
FORCE_BUMP=""

for arg in "$@"; do
  case "$arg" in
    beta) IS_BETA=true ;;
    patch|minor|major) FORCE_BUMP="$arg" ;;
    *) echo "Error: Unknown argument '$arg'. Use patch, minor, major, or beta."; exit 1 ;;
  esac
done

# Get the latest semver tag
# Always find the latest stable tag. In beta mode, also check for an active
# beta series that is *ahead* of the latest stable release.
LATEST_STABLE=$(git tag --sort=-version:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1)

if $IS_BETA; then
  LATEST_BETA=$(git tag --sort=-version:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$' | head -1)

  if [[ -n "$LATEST_STABLE" && -n "$LATEST_BETA" ]]; then
    # Extract base versions for comparison
    STABLE_VER="${LATEST_STABLE#v}"
    BETA_BASE_VER="${LATEST_BETA#v}"
    BETA_BASE_VER="${BETA_BASE_VER%%-beta.*}"

    # Compare: only use the beta tag if its base version is strictly newer
    # than the stable release (e.g., v1.1.0-beta.3 when stable is v1.0.0).
    # If stable >= beta base (e.g., v1.0.0 released after v1.0.0-beta.x),
    # the beta series is complete — start fresh from stable.
    HIGHER=$(printf '%s\n%s\n' "$STABLE_VER" "$BETA_BASE_VER" | sort -V | tail -1)
    if [[ "$HIGHER" == "$BETA_BASE_VER" && "$STABLE_VER" != "$BETA_BASE_VER" ]]; then
      LATEST_TAG="$LATEST_BETA"
    else
      LATEST_TAG="$LATEST_STABLE"
    fi
  elif [[ -n "$LATEST_BETA" ]]; then
    LATEST_TAG="$LATEST_BETA"
  else
    LATEST_TAG="${LATEST_STABLE:-}"
  fi
else
  LATEST_TAG="${LATEST_STABLE:-}"
fi

if [[ -z "$LATEST_TAG" ]]; then
  echo "No existing version tags found. Starting at v0.1.0"
  NEXT_TAG="v0.1.0"
else
  # Parse current version (strip beta suffix if present)
  VERSION="${LATEST_TAG#v}"
  BASE_VERSION="${VERSION%%-beta.*}"
  MAJOR=$(echo "$BASE_VERSION" | cut -d. -f1)
  MINOR=$(echo "$BASE_VERSION" | cut -d. -f2)
  PATCH=$(echo "$BASE_VERSION" | cut -d. -f3)
  CURRENT_IS_BETA=false
  CURRENT_BETA_NUM=0
  if [[ "$VERSION" =~ -beta\.([0-9]+)$ ]]; then
    CURRENT_IS_BETA=true
    CURRENT_BETA_NUM="${BASH_REMATCH[1]}"
  fi

  echo "Current version: $LATEST_TAG"

  if [[ -n "$FORCE_BUMP" ]]; then
    BUMP="$FORCE_BUMP"
    echo "Forced bump type: $BUMP"
  else
    # Analyze commits since last tag to determine bump type
    BUMP="patch"
    BUMP_REASON="no feat or breaking change commits found (defaulting to patch)"
    while IFS= read -r subject; do
      if echo "$subject" | grep -qE '^feat(\(.+\))?!:|^fix(\(.+\))?!:|^refactor(\(.+\))?!:|BREAKING CHANGE'; then
        BUMP="major"
        BUMP_REASON="breaking change: $subject"
        break
      elif echo "$subject" | grep -qE '^feat(\(.+\))?:'; then
        BUMP="minor"
        BUMP_REASON="new feature: $subject"
      fi
    done <<< "$(git log "${LATEST_TAG}..HEAD" --format='%s')"

    echo "Detected bump type: $BUMP"
    echo "  Reason: $BUMP_REASON"
  fi

  # Calculate next version (based on the base version, ignoring beta suffix)
  case "$BUMP" in
    major)
      NEXT_VERSION="v$((MAJOR + 1)).0.0"
      ;;
    minor)
      NEXT_VERSION="v${MAJOR}.$((MINOR + 1)).0"
      ;;
    patch)
      NEXT_VERSION="v${MAJOR}.${MINOR}.$((PATCH + 1))"
      ;;
    *)
      echo "Error: Invalid bump type '$BUMP'. Use major, minor, or patch."
      exit 1
      ;;
  esac

  if $IS_BETA; then
    if $CURRENT_IS_BETA; then
      # Already on a beta — increment the beta number on the same base
      NEXT_TAG="v${BASE_VERSION}-beta.$((CURRENT_BETA_NUM + 1))"
    else
      # Starting a new beta series from the computed next version
      BETA_BASE="$NEXT_VERSION"
      BETA_COUNT=$(git tag --list "${BETA_BASE}-beta.*" | wc -l | tr -d ' ')
      NEXT_TAG="${BETA_BASE}-beta.$((BETA_COUNT + 1))"
    fi
  else
    NEXT_TAG="$NEXT_VERSION"
  fi
fi

# Show what will happen
echo ""
echo "Commits since ${LATEST_TAG:-beginning}:"
if [[ -n "$LATEST_TAG" ]]; then
  git log "${LATEST_TAG}..HEAD" --oneline
else
  git log --oneline
fi

echo ""
echo "Next version: $NEXT_TAG"
echo ""

# Confirm with user
if $IS_BETA; then
  echo "(This is a BETA pre-release)"
fi
read -rp "Create and push tag $NEXT_TAG? [y/N] " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

# Verify local HEAD matches origin before tagging.
# This prevents orphaned tags when local commits haven't been pushed yet.
LOCAL_SHA=$(git rev-parse HEAD)
REMOTE_SHA=$(git ls-remote origin "$(git symbolic-ref --short HEAD)" | cut -f1)
if [[ "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
  echo "Error: Local HEAD ($LOCAL_SHA) does not match origin ($REMOTE_SHA)."
  echo "Push your commits before releasing."
  exit 1
fi

git tag "$NEXT_TAG"
git push origin "$NEXT_TAG"

echo ""
REPO_URL=$(git remote get-url origin | sed 's/.*github.com[:/]\(.*\)\.git/\1/')
if $IS_BETA; then
  echo "Beta tag $NEXT_TAG pushed."
  echo "Create a pre-release at: https://github.com/${REPO_URL}/releases/new?tag=${NEXT_TAG}&prerelease=1"
  echo ""
  echo "Beta testers install via manifest URL:"
  echo "  https://github.com/${REPO_URL}/releases/download/${NEXT_TAG}/module.json"
else
  echo "Tag $NEXT_TAG pushed. The draft-release workflow will create a draft release on GitHub."
  echo "Once ready, publish the draft at: https://github.com/${REPO_URL}/releases"
fi
