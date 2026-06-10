export function encodeGitHubPath(path: string): string {
  let output = '';
  let segmentStart = 0;

  for (let index = 0; index <= path.length; index += 1) {
    if (index !== path.length && path[index] !== '/') {
      continue;
    }

    if (segmentStart > 0) {
      output += '/';
    }
    output += encodeGitHubPathSegment(path.slice(segmentStart, index));
    segmentStart = index + 1;
  }

  return output;
}

export function encodeGitHubPathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}
