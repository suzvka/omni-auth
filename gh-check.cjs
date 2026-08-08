// 检查 git 凭据管理器中的 GitHub 凭据身份（不打印 token）
const { execFileSync } = require("child_process");
const https = require("https");

function api(path, method, token, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.github.com",
        path,
        method,
        headers: {
          Authorization: "Bearer " + token,
          "User-Agent": "omni-migration",
          Accept: "application/vnd.github+json",
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

let out;
try {
  out = execFileSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
  });
} catch (e) {
  console.log("GIT_CREDENTIAL_FAIL:", e.message.split("\n")[0]);
  process.exit(1);
}

const get = (k) => {
  const l = out.split("\n").find((x) => x.startsWith(k + "="));
  return l ? l.slice(k.length + 1) : null;
};
const username = get("username");
const password = get("password");

if (!password) {
  console.log("NO_PASSWORD_IN_CREDENTIAL_MANAGER");
  process.exit(1);
}

(async () => {
  const me = await api("/user", "GET", password);
  console.log("API /user status:", me.status);
  if (me.status === 200) {
    const info = JSON.parse(me.body);
    console.log("credential account login:", info.login, "| name:", info.name);
  } else {
    console.log("body(truncated):", me.body.slice(0, 200));
  }
})();
