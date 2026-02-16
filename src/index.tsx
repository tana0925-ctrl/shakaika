import { Hono } from 'hono'

const app = new Hono()

app.get('/', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>社会科同好会 成長の道しるべ</title>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&family=Zen+Maru+Gothic:wght@500;700&display=swap');
        
        :root {
            --bg-color: #fffaf0;
            --header-line: #d84315;
            --text-main: #444;
            --cat-class: #8d6e63;
            --cat-connect: #66bb6a;
            --cat-research: #42a5f5;
        }

        body {
            font-family: 'Noto Sans JP', sans-serif;
            color: var(--text-main);
            background-color: var(--bg-color);
            padding: 20px;
            margin: 0;
            line-height: 1.4;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            background-color: #fff;
            padding: 20px 30px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.05);
            border-radius: 12px;
            box-sizing: border-box;
            border: 2px solid #f0e6d2;
        }

        /* Header Area */
        .header {
            display: flex;
            justify-content: space-between;
            align-items: flex-end;
            border-bottom: 3px dashed var(--header-line);
            padding-bottom: 8px;
            margin-bottom: 15px;
        }

        .title-block h1 {
            font-family: 'Zen Maru Gothic', sans-serif;
            font-size: 24px;
            margin: 0;
            line-height: 1.2;
            color: var(--header-line);
        }

        .title-block .subtitle {
            font-size: 13px;
            color: #666;
            margin-top: 4px;
            font-weight: 500;
        }

        .compass-logo {
            text-align: right;
            font-weight: bold;
            color: var(--header-line);
        }
        
        .compass-logo span {
            display: block;
            font-size: 10px;
            letter-spacing: 1px;
            color: #555;
        }
        .compass-logo strong {
            font-size: 18px;
            font-family: 'Zen Maru Gothic', sans-serif;
        }

        /* Table Styling */
        table {
            width: 100%;
            border-collapse: separate;
            border-spacing: 0;
            font-size: 10.5pt;
            table-layout: fixed;
            border-radius: 8px;
            overflow: hidden;
            border: 1px solid #ddd;
        }

        th, td {
            border: 1px solid #e0e0e0;
            padding: 8px 10px;
            vertical-align: middle;
            word-wrap: break-word;
        }

        /* Column Widths */
        .col-category { width: 30px; text-align: center; font-weight: bold; writing-mode: vertical-rl; letter-spacing: 3px; color: #fff; border-bottom: 1px solid rgba(255,255,255,0.3);}
        .col-viewpoint { width: 90px; background-color: #fff8e1; font-weight: bold; color: #5d4037; font-family: 'Zen Maru Gothic', sans-serif;}
        .col-step { width: 22%; background-color: #fff; vertical-align: top; }

        /* Header Row Styling */
        thead th {
            text-align: center;
            background-color: #fff;
            border-bottom: 3px solid var(--header-line);
            padding: 8px 5px;
        }

        .step-header {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
        }
        
        .step-label {
            font-size: 13px;
            font-weight: bold;
            color: var(--header-line);
            margin-bottom: 2px;
            font-family: 'Zen Maru Gothic', sans-serif;
        }

        .step-desc {
            font-size: 9px;
            font-weight: bold;
            color: #5d4037;
            background-color: #ffccbc;
            padding: 2px 8px;
            border-radius: 10px;
            white-space: nowrap;
        }

        /* Content Cell Styling */
        .cell-content {
            height: 100%;
            display: flex;
            flex-direction: column;
        }
        .cell-content p {
            margin: 0 0 2px 0;
            font-size: 9.5pt;
            line-height: 1.4;
        }

        .keyword {
            font-weight: bold;
            color: #bf360c;
            display: inline-block;
            margin-bottom: 3px;
            font-size: 10.5pt;
            font-family: 'Zen Maru Gothic', sans-serif;
            border-bottom: 2px dotted #ffab91;
            padding-bottom: 1px;
        }

        /* Category Colors */
        .cat-class { background-color: var(--cat-class); }
        .cat-connect { background-color: var(--cat-connect); }
        .cat-research { background-color: var(--cat-research); }

        /* Action Row */
        .row-action td {
            background-color: #fff3e0;
            border-top: 3px solid #ffb74d;
            padding: 6px 8px;
        }
        .action-list {
            margin: 0;
            padding-left: 14px;
            font-size: 9pt;
            list-style-type: none;
        }
        .action-list li {
            margin-bottom: 2px;
            position: relative;
        }
        .action-list li::before {
            content: '\\1F449';
            font-size: 8px;
            margin-right: 4px;
        }

        .ss-term {
            background: linear-gradient(transparent 70%, #fff59d 70%);
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
            font-weight: bold;
            color: #555;
        }

        /* A4\u6a2a 1\u679a\u306b\u5f37\u5236\u7684\u306b\u53ce\u3081\u308b\u305f\u3081\u306e\u5370\u5237\u8a2d\u5b9a */
        @media print {
            @page {
                size: A4 landscape;
                margin: 5mm;
            }

            body {
                width: 287mm;
                height: 200mm;
                margin: 0;
                padding: 0;
                background-color: #fff;
                -webkit-print-color-adjust: exact;
                print-color-adjust: exact;
                transform-origin: top left;
                zoom: 90%;
            }

            .container {
                width: 100%;
                max-width: none;
                box-shadow: none;
                border: none;
                padding: 0;
                margin: 0;
            }

            .header {
                margin-bottom: 10px;
                padding-bottom: 5px;
                border-bottom-width: 2px;
            }
            .title-block h1 { font-size: 18pt; }
            .title-block .subtitle { font-size: 10pt; }
            .compass-logo strong { font-size: 14pt; }

            table {
                font-size: 8.5pt;
            }
            
            th, td {
                padding: 4px 6px;
            }

            .keyword {
                font-size: 9.5pt;
                margin-bottom: 2px;
            }
            
            .cell-content p {
                font-size: 8.5pt;
                line-height: 1.3;
            }

            .col-category {
                width: 25px;
                letter-spacing: 2px;
                font-size: 9pt;
            }
            
            .col-viewpoint {
                width: 80px;
                font-size: 9pt;
            }
            
            .col-viewpoint div:nth-child(2) {
                font-size: 7.5pt !important;
            }

            .step-label { font-size: 11pt; }
            .step-desc { font-size: 8pt; padding: 1px 6px; }

            .row-action td { padding: 4px 6px; }
            .action-list { font-size: 8.5pt; }
            .action-list li { margin-bottom: 1px; }

            .footer-note {
                margin-top: 5px !important;
            }
        }
    </style>
</head>
<body>

<div class="container">
    
    <!-- Header -->
    <div class="header">
        <div class="title-block">
            <h1>社会科同好会 成長の道しるべ</h1>
            <div class="subtitle">授業も、つながりも。あなたのペースで歩むガイドマップ</div>
        </div>
        <div class="compass-logo">
            <span>NAGOYA SHAKAIKA</span>
            <strong>学びのコンパス</strong>
        </div>
    </div>

    <!-- Matrix Table -->
    <table>
        <thead>
            <tr>
                <th colspan="2" style="background-color: #fff8e1; border-bottom: 3px solid #5d4037;">成長の視点</th>
                <th>
                    <div class="step-header">
                        <span class="step-label">STEP 1</span>
                        <span class="step-desc">🔰 まずはここから</span>
                    </div>
                </th>
                <th>
                    <div class="step-header">
                        <span class="step-label">STEP 2</span>
                        <span class="step-desc">🏃 自分で工夫する</span>
                    </div>
                </th>
                <th>
                    <div class="step-header">
                        <span class="step-label">STEP 3</span>
                        <span class="step-desc">🤝 みんなと高める</span>
                    </div>
                </th>
                <th>
                    <div class="step-header">
                        <span class="step-label">STEP 4</span>
                        <span class="step-desc">🌏 未来を創る</span>
                    </div>
                </th>
            </tr>
        </thead>
        <tbody>
            <!-- Row 1: 授業構想 -->
            <tr>
                <td class="col-category cat-class" rowspan="3">授業<br>準備</td>
                <td class="col-viewpoint">
                    <div>授業をつくる</div>
                    <div style="font-size: 9px; color: #888; margin-top: 2px;">準備・計画</div>
                </td>
                <td class="col-step">
                    <div class="cell-content">
                        <span class="keyword">基本型をまねる</span>
                        <p>教科書や「わたしたちのきょうど」、「あゆみ」を見て、基本的な授業の流れをつかんでみよう。</p>
                    </div>
                </td>
                <td class="col-step">
                    <div class="cell-content">
                        <span class="keyword">実態に合わせる</span>
                        <p>「この子たちなら？」と想像して、名古屋のネタや身近な話題を取り入れよう。</p>
                    </div>
                </td>
                <td class="col-step">
                    <div class="cell-content">
                        <span class="keyword">深い学びを仕掛ける</span>
                        <p>「なぜ？」といった<span class="ss-term">社会的な見方</span>を取り入れた、面白い単元を作ってみよう。</p>
                    </div>
                </td>
                <td class="col-step">
                    <div class="cell-content">
                        <span class="keyword">大きな学びを描く</span>
                        <p>社会科を中心に、SDGsや他教科ともつながるような、広がりのある学びをデザインしよう。</p>
                    </div>
                </td>
            </tr>

            <!-- Row 2: 授業実践 -->
            <tr>
                <td class="col-viewpoint">
                    <div>授業をする</div>
                    <div style="font-size: 9px; color: #888; margin-top: 2px;">技術・対話</div>
                </td>
                <td class="col-step">
                    <div class="cell-content">
                        <span class="keyword">資料で惹きつける</span>
                        <p>地図や写真をドーンと見せて、子供の興味を惹きつける発問をしてみよう。</p>
                    </div>
                </td>
                <td class="col-step">
                    <div class="cell-content">
                        <span class="keyword">対話で盛り上げる</span>
                        <p>子供のつぶやきを拾って、意見を戦わせる場面を作ってみよう。</p>
                    </div>
                </td>
                <td class="col-step">
                    <div class="cell-content">
                        <span class="keyword">探究を支える</span>
                        <p>ICTを使って、子供自身が調べて、考えて、まとめる時間を充実させよう。</p>
                    </div>
                </td>
                <td class="col-step">
                    <div class="cell-content">
                        <span class="keyword">技を伝える</span>
                        <p>若手の授業を見て、具体的なアドバイスをし、授業力を引き上げよう。</p>
                    </div>
                </td>
            </tr>

            <!-- Row 3: 子ども理解・評価 -->
            <tr>
                <td class="col-viewpoint">
                    <div>子供を見る</div>
                    <div style="font-size: 9px; color: #888; margin-top: 2px;">評価・改善</div>
                </td>
                <td class="col-step">
                    <div class="cell-content">
                        <span class="keyword">基礎を確認する</span>
                        <p>地名や用語など、基本的なことが身についたか確認してみよう。</p>
                    </div>
                </td>
                <td class="col-step">
                    <div class="cell-content">
                        <span class="keyword">思考を見取る</span>
                        <p>発言やノートから、「事実を元に考えているかな？」と頭の中をのぞいてみよう。</p>
                    </div>
                </td>
                <td class="col-step">
                    <div class="cell-content">
                        <span class="keyword">頑張りを認める</span>
                        <p>粘り強く調べる姿など、点数になりにくい良さも見つけてみよう。</p>
                    </div>
                </td>
                <td class="col-step">
                    <div class="cell-content">
                        <span class="keyword">授業をより良くする</span>
                        <p>評価規準を作り、子供の姿を元に自分の授業をアップデートしよう。</p>
                    </div>
                </td>
            </tr>

            <!-- Row 4: つながり -->
            <tr>
                <td class="col-category cat-connect">仲間<br>活動</td>
                <td class="col-viewpoint">
                    <div>つながる</div>
                    <div style="font-size: 9px; color: #888; margin-top: 2px;">同僚性・楽しさ</div>
                </td>
                <td class="col-step">
                    <div class="cell-content">
                        <span class="keyword">まずは楽しむ</span>
                        <p>イベントに参加して楽しもう。同期や先輩と顔見知りになれたらOK！</p>
                    </div>
                </td>
                <td class="col-step">
                    <div class="cell-content">
                        <span class="keyword">弱音を吐く</span>
                        <p>悩みを相談したり、失敗談を笑い合ったりできる仲間を作ろう。</p>
                    </div>
                </td>
                <td class="col-step">
                    <div class="cell-content">
                        <span class="keyword">場を盛り上げる</span>
                        <p>飲み会やFWの幹事をして、若手とベテランをつなぐ架け橋になろう。</p>
                    </div>
                </td>
                <td class="col-step">
                    <div class="cell-content">
                        <span class="keyword">次世代を育てる</span>
                        <p>「この会を良くするには？」と未来を語り、次のリーダーたちを育てよう。</p>
                    </div>
                </td>
            </tr>

            <!-- Row 5: 専門性 -->
            <tr>
                <td class="col-category cat-research">研究<br>発信</td>
                <td class="col-viewpoint">
                    <div>深める</div>
                    <div style="font-size: 9px; color: #888; margin-top: 2px;">探究・理論</div>
                </td>
                <td class="col-step">
                    <div class="cell-content">
                        <span class="keyword">「すごい！」に触れる</span>
                        <p>先輩の実践記録を読んで、「こんな授業があるんだ！」と刺激を受けよう。</p>
                    </div>
                </td>
                <td class="col-step">
                    <div class="cell-content">
                        <span class="keyword">実践を書く</span>
                        <p>自分の授業を<span class="ss-term">「体験記録」</span>等の文章にまとめて、整理してみよう。</p>
                    </div>
                </td>
                <td class="col-step">
                    <div class="cell-content">
                        <span class="keyword">理論を磨く</span>
                        <p>テーマを深掘りして議論したり、自分の実践を理論づけたりしてみよう。</p>
                    </div>
                </td>
                <td class="col-step">
                    <div class="cell-content">
                        <span class="keyword">全国へ発信する</span>
                        <p>全国大会などで発表して、名古屋の社会科の魅力を外に向けて発信しよう。</p>
                    </div>
                </td>
            </tr>

            <!-- Action Row -->
            <tr class="row-action">
                <td colspan="2" style="text-align: right; font-weight: bold; padding-right: 20px; color: #e65100;">
                    <i class="fas fa-shoe-prints"></i> おすすめのアクション
                </td>
                <td>
                    <ul class="action-list">
                        <li><strong>若手交流会</strong>で仲間作り</li>
                        <li><strong>授業づくり講座</strong>を聞く</li>
                        <li><strong>懇親会</strong>にとりあえず行く</li>
                    </ul>
                </td>
                <td>
                    <ul class="action-list">
                        <li><strong>スキルアップ研修</strong>に参加</li>
                        <li><strong>体験記録</strong>を書いてみる</li>
                        <li><strong>FW(フィールドワーク)</strong>へGO!</li>
                    </ul>
                </td>
                <td>
                    <ul class="action-list">
                        <li><strong>模擬授業</strong>をやってみる</li>
                        <li><strong>FW・イベント</strong>を企画する</li>
                        <li><strong>研究部</strong>で議論する</li>
                    </ul>
                </td>
                <td>
                    <ul class="action-list">
                        <li><strong>講師</strong>として話す</li>
                        <li><strong>研究紀要</strong>をまとめる</li>
                        <li><strong>全国大会</strong>に行く・呼ぶ</li>
                    </ul>
                </td>
            </tr>

        </tbody>
    </table>
    
    <div class="footer-note" style="margin-top: 15px; display: flex; justify-content: space-between; align-items: flex-start;">
        <div style="font-size: 8.5pt; color: #666;">
            <strong>カテゴリ：</strong>
            <span style="color: #8d6e63;">■ 授業・準備</span>
            <span style="color: #66bb6a;">■ 仲間・活動</span>
            <span style="color: #42a5f5;">■ 研究・発信</span>
        </div>
        <div style="font-size: 8.5pt; color: #777; text-align: right; max-width: 60%;">
            ※これは「ここまでやらなきゃいけない」というノルマではありません。<br>
            今の自分に合った「次の一歩」を見つけるための地図として使ってください。
        </div>
    </div>
</div>

</body>
</html>`)
})

// API endpoint
app.get('/api/health', (c) => {
  return c.json({ status: 'ok', message: 'Social Studies Growth Roadmap is running' })
})

export default app
