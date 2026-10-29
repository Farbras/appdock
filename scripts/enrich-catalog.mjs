import fs from "node:fs";
const apps = JSON.parse(fs.readFileSync("catalog/apps.json", "utf8"));
const all = [
  "chrome",
  "edge",
  "firefox",
  "brave",
  "tor",
  "yandex",
  "opera",
  "vivaldi",
  "vscode",
  "webstorm",
  "idea",
  "pycharm",
  "phpstorm",
  "android-studio",
  "sublime",
  "vim",
  "neovim",
  "eclipse",
  "git",
  "zeal",
  "python",
  "atom",
  "docker",
  "podman",
  "virtualbox",
  "wordcraft",
  "gridcraft",
  "deckcraft",
  "photocraft",
  "libreoffice",
  "onlyoffice",
  "wps",
  "gimp",
  "freecad",
  "librecad",
  "openscad",
  "mysql",
  "postgres",
  "sqlite",
  "mongodb",
  "mariadb",
  "neo4j",
  "dbeaver",
];
const mac = [
  "arc",
  "duckduckgo",
  "github-desktop",
  "notion",
  "word",
  "autocad",
  "fusion",
  "archicad",
];
for (const a of apps) {
  if (all.includes(a.id)) a.platforms = ["windows", "macos", "linux"];
  else if (mac.includes(a.id)) a.platforms = ["windows", "macos"];
  else if (["web", "cloud"].includes(a.type))
    a.platforms = ["windows", "macos", "linux", "web"];
}
const byId = (id) => apps.find((a) => a.id === id);
byId("atom").version = "1.60.0 (архив)";
byId("atom").sources.push("https://github.com/atom/atom/releases/tag/v1.60.0");
for (const id of ["wordcraft", "gridcraft", "deckcraft", "photocraft"])
  byId(id).publisher = "ArtCraft";
byId("sqlserver").licenseNote =
  "SQL Server 2025: Standard Developer и Enterprise Developer бесплатны только для разработки и тестирования вне production. Express — бесплатная редакция с ограничениями. Производственные коммерческие редакции требуют лицензии Microsoft.";
byId("sqlserver").editions = [
  {
    id: "standard-developer",
    name: "Standard Developer 2025",
    description: "Бесплатно для непроизводственной разработки и тестирования.",
  },
  {
    id: "enterprise-developer",
    name: "Enterprise Developer 2025",
    description:
      "Возможности Enterprise для непроизводственной разработки и тестирования.",
  },
  {
    id: "express",
    name: "Express 2025",
    description:
      "Бесплатная ограниченная редакция для разработки и небольших рабочих приложений.",
  },
  {
    id: "commercial",
    name: "Коммерческая редакция",
    description:
      "Редакция, дистрибутив и лицензия выбираются на сайте Microsoft.",
  },
];
byId("oracle").name = "Oracle AI Database";
byId("oracle").aliases = ["Oracle Database", "Oracle Database Free"];
byId("oracle").website = "https://www.oracle.com/database/free/";
byId("oracle").sources.unshift(byId("oracle").website);
byId("oracle").platforms = ["windows", "linux"];
byId("oracle").licenseNote =
  "Oracle AI Database Free — бесплатная редакция по условиям Oracle с лимитами ресурсов. Коммерческие редакции и дополнения лицензируются отдельно.";
byId("oracle").editions = [
  {
    id: "free",
    name: "Oracle AI Database 26ai Free",
    description:
      "Бесплатная редакция: до 2 CPU, 2 ГБ RAM и 12 ГБ данных по текущим условиям Oracle. Windows x64 или Linux.",
  },
  {
    id: "commercial",
    name: "Коммерческая редакция Oracle",
    description:
      "Лицензия, редакция и дистрибутив выбираются на официальном портале Oracle.",
  },
];
byId("idea").licenseNote =
  "Единая IntelliJ IDEA: базовые возможности Java и Kotlin бесплатны для коммерческих и некоммерческих проектов. Расширенные возможности Ultimate — по подписке.";
byId("idea").sources.push(
  "https://lp.jetbrains.com/intellij-idea-unified-faq/",
);
byId("idea").editions = [
  {
    id: "default",
    name: "IntelliJ IDEA · единая поставка",
    description:
      "Бесплатное ядро Java / Kotlin. Ultimate активируется по подписке; отдельная Community сохранена как поисковый псевдоним.",
  },
];
byId("webstorm").licenseNote =
  "Бесплатно для индивидуального некоммерческого использования по условиям JetBrains. Коммерческая разработка требует подписки.";
byId("webstorm").sources.push("https://www.jetbrains.com/webstorm/buy/");
byId("pycharm").licenseNote =
  "Единая PyCharm: базовые возможности бесплатны, Pro-возможности — по подписке или пробному доступу. Условия — у JetBrains.";
byId("pycharm").editions = [
  {
    id: "default",
    name: "PyCharm · единая поставка",
    description:
      "Бесплатные базовые возможности; Pro активируется после установки. Community и Professional сохранены как поисковые псевдонимы.",
  },
];
byId("autocad").licenseNote =
  "Подписка Autodesk / Flex. Пробная версия AutoCAD — 15 дней по текущим условиям Autodesk; нужен Autodesk Account.";
byId("autocad").sources.push(
  "https://www.autodesk.com/products/autocad/free-trial",
);
byId("autocad").editions = [
  {
    id: "autocad",
    name: "AutoCAD",
    description:
      "Полная версия по подписке Autodesk. Доступные toolsets и состав выберите в Autodesk Account.",
  },
  {
    id: "autocad-lt",
    name: "AutoCAD LT",
    description:
      "Отдельный продукт для 2D-проектирования. Лицензия и дистрибутив выбираются у Autodesk.",
  },
];
byId("solidworks").license = "paid";
byId("solidworks").licenseNote =
  "Коммерческие лицензии SOLIDWORKS Design. Дистрибутив и активация зависят от выбранного пакета и условий поставщика.";
byId("solidworks").editions = [
  "Standard",
  "Professional",
  "Premium",
  "Ultimate",
].map((name) => ({
  id: name.toLowerCase(),
  name: `SOLIDWORKS Design ${name}`,
  description:
    "Коммерческий пакет. Возможности, тип лицензии и доступность уточняются на официальной странице перед загрузкой.",
}));
byId("solidworks").sources.push(
  "https://www.solidworks.com/solution/solidworks-design-packages-find-your-best-fit",
);
byId("catia").license = "paid";
byId("r7").license = "paid";
byId("myoffice").license = "paid";
byId("vmware").editions[0].description =
  "Workstation Pro для Windows / Linux. Бесплатно по текущим условиям Broadcom; доступ к загрузке может требовать аккаунт.";
for (const a of apps) a.sources = [...new Set(a.sources)];
fs.writeFileSync("catalog/apps.json", JSON.stringify(apps, null, 2) + "\n");
