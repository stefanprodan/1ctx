// A focus the person did not ask for opens a phone's keyboard over the page.
export function touch(): boolean {
  return (
    typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches
  );
}
