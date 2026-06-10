export function encodeGitHubPath(path: string): string {
  return path.split('/').map(encodeGitHubPathSegment).join('/');
}

export function encodeGitHubPathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}
