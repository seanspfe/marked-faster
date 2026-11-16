# marked-faster
[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/seanspfe/marked-faster/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/seanspfe/marked-faster/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free drop-in Markdown renderer that matches marked 18.1.3's HTML output byte for byte. It lexes blocks first (queuing inline work), then drains the inline queue and renders the token tree.

## Run it
```sh
node main.ts
```
It reads /input/cases.json and writes /output/html.json.

---
<sub>Entered on [make.fun](https://make.fun/?ref=aa6nhjev&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
