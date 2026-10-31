const STATE_KEY = Symbol.for("@engen-tech/hatch/pi-extension-instance");

interface ExtensionInstanceState {
  root?: string;
}

function state(): ExtensionInstanceState {
  const scope = globalThis as typeof globalThis & { [STATE_KEY]?: ExtensionInstanceState };
  scope[STATE_KEY] ??= {};
  return scope[STATE_KEY];
}

export function claimExtensionInstance(packageRoot: string): () => void {
  const current = state();
  if (current.root) {
    throw new Error(
      current.root === packageRoot
        ? `Hatch Pi extension loaded twice from ${packageRoot}`
        : `Hatch Pi extension loaded from two package roots: ${current.root} and ${packageRoot}`,
    );
  }
  current.root = packageRoot;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (current.root === packageRoot) delete current.root;
  };
}
