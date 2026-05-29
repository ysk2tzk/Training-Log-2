## データベース

### Log

- Id, int, PK
- Category
- Item, varchar(32)
- Weight, float
- Reps, float
- Gear, varcha32
- Socre, int
- Created_At

### Corfficient

- Id, int, PK
- Name, varchar(32)
- Value, float
- Start_Date, date
- End_Date, date

### Gear

- Id, int, PK
- Name, varchar(32)
- Status
- Distance, float
- Start_Date, date
- End_Date, date

## 機能

- スマートフォンで入力することを前提とした縦長のWebページとする。
- 先頭に日付入力部品を設ける。
- 日付の下にカテゴリドロップダウンリスト(Training or Reward) を設ける。
- カテゴリでTrainingが選択された場合
    1. Logテーブルから、カテゴリがTrainingのItemを重複なく取得し昇順に並べたものの最後尾に「その他(自由入力)」を追加し、アイテムドロップダウンリストを設ける。
    2. アイテムで「ラン」もしくは「バイク」が選択された場合、アイテムの下にRepsテキストボックスを設ける。プレースホルダーは"0.0km"とする。Repsの下にGearドロップダウンリストを設ける。
    3. アイテムで「その他(自由入力)」が選ばれた場合、アイテムの下にフリーテキストボックスを設ける。フリーテキストボックスの下にWeightテキストボックスを設ける。プレースホルダーは"0.0kg"とする。Weightの下にRepsテキストボックスを設ける。プレースホルダーは”回”とする。
    4. 上記以外の項目が選ばれた場合、アイテムの下にWeightテキストボックスを設ける。プレースホルダーは"0.0kg"とする。Weightの下にRepsテキストボックスを設ける。プレースホルダーは”回”とする。
- カテゴリでRewardが選択された場合
    1. 過去のログから、カテゴリがRewardのItemを重複なく取得し昇順に並べたものの最後尾に「その他(自由入力)」を追加し、アイテムドロップダウンリストを設ける。アイテムドロップダウンリストの下にRepsテキストボックスを設ける。プレースホルダーは”円”とする。
    2. アイテムで「その他(自由入力)」が選ばれた場合、アイテムとRepsの間にフリーテキストボックスを設ける。
- 入力エリアの直下に「追加」ボタンを用意する。
- 追加ボタンの下に累計スコアを表示する。(他よりも目立つフォントで)
    - 累計スコアはLogテーブルの、Sum(Score) で算出する。
- 累計スコアの下には、Logテーブルの内容を表示する。
    - Created_atでグルーピングし、降順に並べる。
    - 表示する内容は、Item, Weight, Reps, Gear, Socre
- 追加ボタンを押下すると、入力した内容をLogテーブルおよびGearテーブルに記録する。
    - カテゴリがTraining、かつ、アイテムが「ラン」もしくは「バイク」の場合
        - [Log.ID](http://Log.ID) = 自動採番
        - Log.Category = “Training”
        - Log.Item = アイテムドロップダウンリスト
        - Log.Weight = 0
        - Log.Reps = Repsテキストボックス
        - Log.Gear = Gearドロップダウンリスト
        - Log.Score = Repsテキストボックス  * 係数 (後述)
        - Log.Created_At = 日付
        - [Gear.Name](http://Gear.Name) = ギア の、DistanceにRepsテキストボックスの値を加算する。
    - カテゴリがTraining、かつ、アイテムが上記以外の場合
        - [Log.ID](http://Log.ID) = 自動採番
        - Log.Category = “Training”
        - Log.Item = アイテムドロップダウンリスト
        - Log.Weight = Weightテキストボックス
        - Log.Reps = Repsテキストボックス
        - Log.Gear = “”
        - Log.Score = Repsテキストボックス  * 係数 (後述) * Weightテキストボックス
        - Log.Created_At = 日付
    - カテゴリがRewardの場合
        - [Log.ID](http://Log.ID) = 自動採番
        - Log.Category = “Reward”
        - Log.Item = アイテムドロップダウンリスト
        - Log.Weight = 0
        - Log.Reps = Repsテキストボックス
        - Log.Gear = “”
        - Log.Score = Repsテキストボックス  * 係数 (後述)
        - Log.Created_At = 日付
    - 係数の求め方
        - カテゴリ－が”Training”の場合、以下の条件に該当するものを係数とする
            - Coefficientテーブルに存在する、Start_Date ≤ 日付 < End_date、かつ、Name = アイテムの、Valueの値
            - 上記で該当するものが存在しない場合、Start_Date ≤ 日付 < End_date、かつ、Name = Defaultの、Valueの値
        - カテゴリ－が”Reward”の場合、以下の条件に該当するものを係数とする
            - Coefficientテーブルに存在する、Start_Date ≤ 日付 < End_date、かつ、Name = “Reward” の、Valueの値