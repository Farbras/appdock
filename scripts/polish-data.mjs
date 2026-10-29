import fs from "node:fs";
const apps = JSON.parse(fs.readFileSync("catalog/apps.json", "utf8"));
for (const app of apps) {
  const file = `public/icons/${app.icon}.svg`;
  if (fs.existsSync(file)) {
    let svg = fs.readFileSync(file, "utf8");
    svg = svg.replace(/<svg /, `<svg fill="${app.color}" `);
    fs.writeFileSync(file, svg);
  }
}
const links = {
  "android-studio": [
    "https://developer.android.com/studio/intro/update",
    "https://developer.android.com/studio/run/emulator",
    "https://developer.android.com/studio/intro/update#sdk-manager",
  ],
  docker: ["https://docs.docker.com/desktop/setup/install/windows-install/"],
  podman: [
    "https://podman-desktop.io/downloads",
    "https://docs.podman.io/en/latest/markdown/podman-machine-init.1.html",
  ],
  virtualbox: ["https://www.virtualbox.org/manual/ch10.html"],
  dynamodb: [
    "https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.html",
  ],
  firebase: [
    "https://firebase.google.com/docs/emulator-suite/install_and_configure",
  ],
  redis: [
    "https://redis.io/docs/latest/operate/oss_and_stack/install/archive/install-redis/install-redis-on-windows/",
    "https://redis.io/docs/latest/operate/oss_and_stack/install/install-stack/docker/",
  ],
  cassandra: [
    "https://cassandra.apache.org/doc/latest/cassandra/getting_started/installing.html",
  ],
  clickhouse: [
    "https://clickhouse.com/docs/install",
    "https://hub.docker.com/r/clickhouse/clickhouse-server/",
  ],
};
for (const a of apps) {
  if (links[a.id]) {
    a.sources = [a.sources[0], ...links[a.id], ...a.sources.slice(1)];
  }
  if (a.id === "vscode")
    a.sources.push(
      ...JSON.parse(fs.readFileSync("catalog/extensions.json")).map(
        (e) => e.source,
      ),
    );
}
fs.writeFileSync("catalog/apps.json", JSON.stringify(apps, null, 2) + "\n");
