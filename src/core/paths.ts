/** Tool paths are always relative, slash-separated paths inside the workspace. */
export function normalizeWorkspacePath(input: string): string {
  const path = input.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!path || path.includes('\0') || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
    throw new Error('Expected a relative workspace path.');
  }
  const parts = path.split('/');
  if (parts.some((part) => part === '..' || part === '' || part === '.')) {
    throw new Error('Workspace paths must not contain traversal or empty segments.');
  }
  return parts.join('/');
}
