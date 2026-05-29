const modules = [];

export function registerLanguage(mod) {
  modules.push(mod);
}

export function getLanguages() {
  return modules;
}

export function getLanguage(id) {
  return modules.find(m => m.id === id) || null;
}

export function getLanguageForExt(ext) {
  return modules.find(m => m.extensions.includes(ext)) || null;
}

export async function loadDefaultLanguages() {
  const { default: generic } = await import('./generic.js');
  registerLanguage(generic);
  const { default: php } = await import('./php.js');
  registerLanguage(php);
  const { default: js } = await import('./js.js');
  registerLanguage(js);
}
