// 윈도 10·11에 처음부터 들어 있는 글꼴 패밀리(Microsoft 'Windows 10 font list' 기준).
// 키트 글꼴 칸에서 이 이름들은 '윈도 기본'으로 묶고, 나머지는 '이 PC에 설치한 글꼴'로 묶는다.
//
// 설치 폴더나 설치 시각으로 가르지 않는 이유(실제로 재 봤다):
// - '모든 사용자'로 깐 글꼴(Pretendard)은 사용자 폴더가 아니라 C:\Windows\Fonts에 들어간다.
// - 윈도 업데이트가 기본 글꼴을 나중에 더하기도 해서(Ink Free, Microsoft YaHei…) 파일 시각으로도 못 가른다.
export const WINDOWS_KO = new Set([
  "Malgun Gothic", "Malgun Gothic Semilight", "Batang", "BatangChe", "Dotum", "DotumChe",
  "Gulim", "GulimChe", "Gungsuh", "GungsuhChe",
]);

export const WINDOWS_FONTS = new Set([
  ...WINDOWS_KO,
  "Arial", "Arial Black", "Bahnschrift", "Calibri", "Calibri Light", "Cambria", "Cambria Math", "Candara",
  "Candara Light", "Cascadia Code", "Cascadia Mono", "Comic Sans MS", "Consolas", "Constantia", "Corbel",
  "Corbel Light", "Courier New", "Ebrima", "Franklin Gothic", "Franklin Gothic Medium", "Gabriola", "Gadugi",
  "Georgia", "HoloLens MDL2 Assets", "Impact", "Ink Free", "Javanese Text", "Leelawadee UI",
  "Leelawadee UI Semilight", "Lucida Console", "Lucida Sans Unicode", "Marlett", "Microsoft Himalaya",
  "Microsoft JhengHei", "Microsoft JhengHei Light", "Microsoft JhengHei UI", "Microsoft JhengHei UI Light",
  "Microsoft New Tai Lue", "Microsoft PhagsPa", "Microsoft Sans Serif", "Microsoft Tai Le", "Microsoft YaHei",
  "Microsoft YaHei Light", "Microsoft YaHei UI", "Microsoft YaHei UI Light", "Microsoft Yi Baiti",
  "MingLiU-ExtB", "MingLiU_HKSCS-ExtB", "Mongolian Baiti", "MS Gothic", "MS PGothic", "MS UI Gothic", "MV Boli",
  "Myanmar Text", "Nirmala UI", "Nirmala UI Semilight", "NSimSun", "Palatino Linotype", "PMingLiU-ExtB",
  "Segoe Fluent Icons", "Segoe MDL2 Assets", "Segoe Print", "Segoe Script", "Segoe UI", "Segoe UI Black",
  "Segoe UI Emoji", "Segoe UI Historic", "Segoe UI Light", "Segoe UI Semibold", "Segoe UI Semilight",
  "Segoe UI Symbol", "SimSun", "SimSun-ExtB", "SimSun-ExtG", "Sitka Banner", "Sitka Display", "Sitka Heading",
  "Sitka Small", "Sitka Subheading", "Sitka Text", "Sylfaen", "Symbol", "Tahoma", "Times New Roman",
  "Trebuchet MS", "Verdana", "Webdings", "Wingdings", "Yu Gothic", "Yu Gothic Light", "Yu Gothic Medium",
  "Yu Gothic UI", "Yu Gothic UI Light", "Yu Gothic UI Semibold", "Yu Gothic UI Semilight",
]);
