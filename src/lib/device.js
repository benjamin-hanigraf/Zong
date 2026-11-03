// Per-device id (stable across launches; used for Team membership and Stage Mode presence).


export function getDeviceId() {
  if (typeof localStorage === "undefined") return "dev_default";
  let id = localStorage.getItem("zong:device-id");
  if (!id) {
    id = "dev_" + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
    localStorage.setItem("zong:device-id", id);
  }
  return id;
}
