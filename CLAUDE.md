# mono-labo リポジトリの作業ルール

このリポジトリは GitHub Pages で公開中の本番サイト(https://easyautomate2024-cell.github.io/mono-labo/)。
複数のClaude Codeセッション(ローカルPC・クラウド)が同じアカウントで操作することがある。

## プッシュ前の必須手順

1. 必ず `git fetch` してリモート差分を確認する
2. リモートに新しいコミットがあれば取り込んでから(rebase/merge)プッシュする
3. **ファイル丸ごとの上書きは禁止。** 手元のコピーが古い可能性を常に疑い、対象箇所だけの小さな編集・コミットにする
   (2026-08-14に古いindex.htmlでの丸ごと上書きプッシュにより、販売中表記が開発中に巻き戻る事故が発生)

## 触ってはいけないもの

- 作業ツリーの未コミット変更(ss_circuit.png の変更など)は意図的なもの。削除・コミット・checkoutで破棄しない
- `note_*_draft.html` / `note_*_paste.txt` はnote記事の下書き。未コミットのまま置く運用。コミットしない
- `articles.json` は GitHub Actions(毎日12:00 JST)がnote RSSから自動更新する。手動編集は基本不要

## サイトの現在の状態(2026-08-14)

- TRAILER LEVEL は BOOTH で先行販売中: https://mono-labo.booth.pm/items/8710345
- index.html / trailerlevel.html とも「先行販売中」バッジ+BOOTH購入ボタンが正。「開発中」への巻き戻しは事故
- ユーザーはGitHubを直接編集しない。リモートの見慣れないコミットは別セッションの作業
