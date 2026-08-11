import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';

const DAILY_LIMIT = 20;

// サーバー側専用のSupabaseクライアント（APIキーはブラウザに露出しない）
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

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

    // 2. リクエストから画像を取得
    const formData = await request.formData();
    const imageFile = formData.get('image') as File | null;

    if (!imageFile) {
      return NextResponse.json(
        { error: '画像が選択されていません。' },
        { status: 400 }
      );
    }

    // 3. 画像をBase64に変換
    const imageBytes = await imageFile.arrayBuffer();
    const imageBase64 = Buffer.from(imageBytes).toString('base64');
    const mimeType = imageFile.type as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic';

    // 4. Gemini APIで食材を抽出（キーはサーバー側のみ・ブラウザ非公開）
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const prompt = `この画像から料理のメニュー名と使われている主な食材を抽出してください。
出力形式は必ず以下の「1行1メニュー」の形式のみで返してください。余計な文章や説明は一切不要です。

【出力フォーマット】
メニュー名: 食材1, 食材2, 食材3

複数のメニューがある場合は1行ずつ書いてください。
料理が1品だけの場合も同じ形式で1行だけ返してください。`;

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          mimeType,
          data: imageBase64,
        },
      },
    ]);

    const extractedText = result.response.text().trim();

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
