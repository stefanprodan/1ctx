export async function load(name: string) {
  return import(`./views/${name}.ts`);
}
