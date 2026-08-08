// GitHub 迁移：创建 omni-auth 仓库 / 归档旧仓库（token 不落盘不打印）
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
          "Content-Type": "application/json",
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

function getCredential() {
  const out = execFileSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
  });
  const get = (k) => {
    const l = out.split("\n").find((x) => x.startsWith(k + "="));
    return l ? l.slice(k.length + 1) : null;
  };
  return get("password");
}

const token = getCredential();
if (!token) {
  console.log("NO_CREDENTIAL");
  process.exit(1);
}

const mode = process.argv[2]; // create | archive

(async () => {
  if (mode === "create") {
    const r = await api("/user/repos", "POST", token, {
      name: "omni-auth",
      private: true,
      description: "OmniAuth — omnichannel authentication SDK, framework-agnostic, built on Better Auth",
    });
    console.log("create repo status:", r.status);
    if (r.status === 201) {
      const info = JSON.parse(r.body);
      console.log("created:", info.full_name, "| private:", info.private, "| url:", info.html_url);
    } else {
      console.log("body:", r.body.slice(0, 400));
    }
  } else if (mode === "archive") {
    // 先更新描述注明已迁移，再归档
    const d = await api("/repos/suzvka/ChangfengUserCenter", "PATCH", token, {
      description: "已迁移至 https://github.com/suzvka/omni-auth（本仓库已归档）",
    });
    console.log("update description status:", d.status);
    const a = await api("/repos/suzvka/ChangfengUserCenter", "PATCH", token, { archived: true });
    console.log("archive status:", a.status);
    if (a.status === 200) {
      const info = JSON.parse(a.body);
      console.log("archived:", info.archived, "| repo:", info.full_name);
    } else {
      console.log("body:", a.body.slice(0, 400));
    }
  } else {
    console.log("usage: node gh-migrate.cjs create|archive");
    process.exit(1);
  }
})();
