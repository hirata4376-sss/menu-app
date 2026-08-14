import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';

const DAILY_LIMIT = 20;

/** 1回の抽出に添付できる画像の枚数。分割されたレシピを想定 */
const MAX_IMAGES = 4;

/**
 * 全画像の合計サイズ上限（4MB）。
 * Vercelのサーバーレス関数はリクエストボディが4.5MBまでのため、少し手前で止める。
 */
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

/** 表記ルール。1枚でも複数枚でも共通 */
const COMMON_RULES = `【ルール】
- 食材名と分量はスペースで区切る（例: 豚肉 200g）
- 分量が読み取れない場合は食材名だけ書く
- 調味料（醤油・みりん・砂糖・塩・油など）は食材名の先頭に # を付ける（例: #醤油 大さじ2）`;

/**
 * 画像の枚数でプロンプトを出し分ける。
 * 複数枚は「1つのレシピが分割されたもの」として扱い、必ず1行にまとめさせる。
 */
const buildPrompt = (imageCount: number): string => {
  if (imageCount === 1) {
    return `この画像から料理のメニュー名と、使われている食材・分量を抽出してください。
出力形式は必ず以下の「1行1メニュー」の形式のみで返してください。余計な文章や説明は一切不要です。

【出力フォーマット】
メニュー名: 食材1 分量1, 食材2 分量2, 食材3 分量3

${COMMON_RULES}
- 複数のメニューがある場合は1行ずつ書く
- 料理が1品だけの場合も同じ形式で1行だけ返す`;
  }

  return `${imageCount}枚の画像を渡します。これらは**1つの同じレシピを分割したもの**で、渡された順に上から続いています。
すべての画像を通して**1品の料理**として読み取り、メニュー名と食材・分量を抽出してください。
出力は必ず以下の形式で、**1行だけ**返してください。複数行にしてはいけません。余計な文章や説明も一切不要です。

【出力フォーマット】
メニュー名: 食材1 分量1, 食材2 分量2, 食材3 分量3

${COMMON_RULES}
- メニュー名は、いずれかの画像に書かれている料理名を1つだけ選ぶ
- 画像をまたいで同じ食材が出てきた場合は1つにまとめる（重複して書かない）
- 材料が複数の画像に分かれている場合は、すべて集めて1行に統合する`;
};

// サーバー側専用のSupabaseクライアント（APIキーはブラウザに露出しない）
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

export async function POST(request: NextRequest) {
  try {
    // 1. 本日の利用回数を確認
    const today = new Date().toISOString().split('T')[0];

    const { data: usageData } = await supabase
      .from('api_usage')
      .select('count')
      .eq('date', today)
      .maybeSingle();

    const currentCount = usageData?.count ?? 0;

    if (currentCount >= DAILY_LIMIT) {
      return NextResponse.json(
        { error: `本日の利用上限（${DAILY_LIMIT}回）に達しました。明日また試してください。` },
        { status: 429 }
      );
    }

    // 2. リクエストから画像を取得（複数枚対応。'image' は旧クライアント用のフォールバック）
    const formData = await request.formData();
    const imageFiles = formData.getAll('images').filter(
      (v): v is File => v instanceof File
    );

    if (imageFiles.length === 0) {
      const legacy = formData.get('image');
      if (legacy instanceof File) imageFiles.push(legacy);
    }

    if (imageFiles.length === 0) {
      return NextResponse.json(
        { error: '画像が選択されていません。' },
        { status: 400 }
      );
    }

    if (imageFiles.length > MAX_IMAGES) {
      return NextResponse.json(
        { error: `画像は${MAX_IMAGES}枚までです。` },
        { status: 400 }
      );
    }

    const totalBytes = imageFiles.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      return NextResponse.json(
        { error: '画像の合計サイズが大きすぎます（4MBまで）。枚数を減らすか、小さい画像を使ってください。' },
        { status: 400 }
      );
    }

    // 3. 画像をBase64に変換（選択された順を保つ）
    const imageParts = await Promise.all(
      imageFiles.map(async (file) => ({
        inlineData: {
          mimeType: file.type,
          data: Buffer.from(await file.arrayBuffer()).toString('base64'),
        },
      }))
    );

    // 4. Gemini APIで食材を抽出（キーはサーバー側のみ・ブラウザ非公開）
    const prompt = buildPrompt(imageFiles.length);

    const response = await genAI.models.generateContent({
      model: 'gemini-flash-latest',
      contents: [
        {
          role: 'user',
          parts: [...imageParts, { text: prompt }],
        },
      ],
    });

    const extractedText = (response.text ?? '').trim();

    // 5. 利用回数を更新（upsert で日付が重複しても安全に書き込み）
    await supabase
      .from('api_usage')
      .upsert({ date: today, count: currentCount + 1 }, { onConflict: 'date' });

    return NextResponse.json({
      result: extractedText,
      remaining: DAILY_LIMIT - (currentCount + 1),
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Gemini API error:', message);
    return NextResponse.json(
      { error: `AI処理エラー: ${message}` },
      { status: 500 }
    );
  }
}
