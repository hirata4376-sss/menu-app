"use client";

import { useState, useEffect, useMemo } from "react";
import { supabase } from "@/utils/supabase";

type Menu = {
  id: string;
  name: string;
  ingredients: string[];
  memo?: string;
  created_at?: string;
};

type IngredientRow = {
  name: string;
  amount: string;
  isSeasoning: boolean;
  /** ユーザーが調味料チェックを手動で操作したか（自動判定の上書きを防ぐ） */
  touched?: boolean;
};

// ===================================================================
// 調味料の判定
// ===================================================================

/** 保存形式のマーカー。先頭に付いていれば調味料 */
const SEASONING_PREFIX = "#";

/** 組み込みの調味料辞書（初期チェックのための候補。手で外せる） */
const SEASONINGS: string[] = [
  "醤油", "しょうゆ", "しょう油", "濃口醤油", "薄口醤油",
  "みりん", "味醂", "酒", "料理酒", "日本酒",
  "砂糖", "上白糖", "きび砂糖", "塩", "こしょう", "胡椒", "黒こしょう", "塩こしょう",
  "味噌", "みそ", "酢", "米酢", "穀物酢", "ポン酢",
  "油", "サラダ油", "ごま油", "オリーブオイル", "オリーブ油", "揚げ油",
  "マヨネーズ", "ケチャップ", "ソース", "中濃ソース", "ウスターソース", "オイスターソース",
  "めんつゆ", "白だし", "だし", "だし汁", "だしの素", "和風だし", "顆粒だし",
  "コンソメ", "鶏がらスープの素", "中華スープの素", "ブイヨン",
  "片栗粉", "小麦粉", "薄力粉", "強力粉", "パン粉",
  "豆板醤", "甜麺醤", "コチュジャン", "ナンプラー", "カレー粉", "ラー油",
  "わさび", "からし", "マスタード", "七味唐辛子", "一味唐辛子", "山椒",
  "ローリエ", "はちみつ", "蜂蜜", "みそだれ", "焼肉のたれ",
];

// ===================================================================
// 量のパース（数値＋単位）
// ===================================================================

type ParsedAmount = { value: number; unit: string };

/** Unicodeの分数記号 */
const VULGAR_FRACTIONS: Record<string, string> = {
  "½": "1/2", "⅓": "1/3", "⅔": "2/3", "¼": "1/4", "¾": "3/4", "⅕": "1/5",
};

/** 単位の表記ゆれを吸収する */
const UNIT_ALIASES: Record<string, string> = {
  "グラム": "g", "G": "g", "gr": "g",
  "キロ": "kg", "キログラム": "kg",
  "ミリリットル": "ml", "cc": "ml", "CC": "ml", "ML": "ml",
  "リットル": "L", "l": "L",
  "コ": "個", "こ": "個", "ケ": "個", "ヶ": "個", "個分": "個",
  "ホン": "本", "マイ": "枚",
  "パック分": "パック",
};

/** 全角英数記号を半角に変換する */
const toHalfWidth = (s: string): string =>
  s
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ");

const normalizeUnit = (u: string): string => {
  const t = u.trim().replace(/^[のっ・]+/, "").trim();
  return UNIT_ALIASES[t] ?? t;
};

/**
 * 「200g」「1/2個」「1と1/2カップ」などを { 数値, 単位 } に分解する。
 * 「大さじ1」「少々」「適量」のように数値が取り出せないものは null を返し、
 * 合計せずそのまま表示する。
 */
const parseAmount = (raw: string): ParsedAmount | null => {
  if (!raw) return null;
  let s = toHalfWidth(raw).trim();
  for (const [k, v] of Object.entries(VULGAR_FRACTIONS)) s = s.split(k).join(v);
  s = s.replace(/^(約|およそ)\s*/, "").trim();
  if (!s) return null;

  // 「半分」「半量」→ 0.5（単位は同じ食材の他の量から補う）
  if (/^(半分|半|半量)$/.test(s)) return { value: 0.5, unit: "" };

  let m: RegExpMatchArray | null;

  // 帯分数「1と1/2」「1 1/2」
  if ((m = s.match(/^(\d+)\s*(?:と|\s+)\s*(\d+)\s*\/\s*(\d+)(.*)$/))) {
    const d = parseInt(m[3], 10);
    if (!d) return null;
    return { value: parseInt(m[1], 10) + parseInt(m[2], 10) / d, unit: normalizeUnit(m[4]) };
  }
  // 「2分の1本」
  if ((m = s.match(/^(\d+)\s*分の\s*(\d+)(.*)$/))) {
    const d = parseInt(m[1], 10);
    if (!d) return null;
    return { value: parseInt(m[2], 10) / d, unit: normalizeUnit(m[3]) };
  }
  // 分数「1/2」
  if ((m = s.match(/^(\d+)\s*\/\s*(\d+)(.*)$/))) {
    const d = parseInt(m[2], 10);
    if (!d) return null;
    return { value: parseInt(m[1], 10) / d, unit: normalizeUnit(m[3]) };
  }
  // 小数・整数「200g」「0.5個」
  if ((m = s.match(/^(\d+(?:\.\d+)?)(.*)$/))) {
    return { value: parseFloat(m[1]), unit: normalizeUnit(m[2]) };
  }
  return null;
};

const formatNumber = (n: number): string => String(Math.round(n * 100) / 100);

/**
 * 同じ食材の量をまとめる。
 * 単位が同じものだけを合計し、違う単位は「200g ＋ 1パック」のように併記する。
 * 数値が取れない量（大さじ1・少々など）は合計せず、重複を除いて並べる。
 */
const sumAmounts = (amounts: string[]): string => {
  const parsed: ParsedAmount[] = [];
  const unparsable: string[] = [];

  for (const a of amounts) {
    const p = parseAmount(a);
    if (p) parsed.push(p);
    else if (a.trim()) unparsable.push(a.trim());
  }

  // 単位が1種類しか出てこない場合、単位なしの数値（「半分」など）はその単位とみなす
  const units = [...new Set(parsed.map((p) => p.unit).filter((u) => u !== ""))];
  if (units.length === 1) {
    parsed.forEach((p) => {
      if (p.unit === "") p.unit = units[0];
    });
  }

  const sums = new Map<string, number>();
  for (const p of parsed) sums.set(p.unit, (sums.get(p.unit) ?? 0) + p.value);

  const parts = [...sums.entries()].map(([u, v]) => `${formatNumber(v)}${u}`);
  const uniqueRaw = [...new Set(unparsable)];
  return [...parts, ...uniqueRaw].join(" ＋ ");
};

// ===================================================================
// 食材文字列の読み書き
// ===================================================================

// "#醤油:少々" → { name: "醤油", amount: "少々", isSeasoning: true }
const parseIngredient = (str: string): IngredientRow => {
  let s = str;
  let isSeasoning = false;
  if (s.startsWith(SEASONING_PREFIX)) {
    isSeasoning = true;
    s = s.slice(SEASONING_PREFIX.length);
  }
  const idx = s.indexOf(":");
  if (idx === -1) return { name: s, amount: "", isSeasoning };
  return { name: s.slice(0, idx), amount: s.slice(idx + 1), isSeasoning };
};

// { name: "醤油", amount: "少々", isSeasoning: true } → "#醤油:少々"
const formatIngredient = (row: IngredientRow): string => {
  const name = row.name.trim();
  const amount = row.amount.trim();
  if (!name) return "";
  const base = amount ? `${name}:${amount}` : name;
  return row.isSeasoning ? SEASONING_PREFIX + base : base;
};

const emptyRow = (): IngredientRow => ({ name: "", amount: "", isSeasoning: false });

// ===================================================================
// 一括登録用のプロンプト（呪文）
// ===================================================================

/** 呪文に差し込む登録済み食材名の上限（長くなりすぎるのを防ぐ） */
const MAX_PROMPT_SUGGESTIONS = 200;

/** 1回の抽出に添付できる画像の枚数（route.ts 側と揃えること） */
const MAX_IMAGES = 4;

/** 全画像の合計サイズ上限（4MB）。Vercelのボディ上限4.5MBの手前で止める */
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

/** 画像プレビュー用にファイルをdataURLへ変換する */
const readAsDataURL = (file: File): Promise<string> =>
  new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });

const BASE_PROMPT = `以下の画像（またはテキスト）から料理のメニュー名と、使われている主な食材・分量を抽出してください。
出力形式は必ず以下の「1行1メニュー」の形式でお願いします。余計な文章は不要です。

【出力フォーマット】
メニュー名: 食材1 分量1, 食材2 分量2, 食材3 分量3

【表記のルール】
1. 食材名は原則として漢字で書く（例:「ぶたにく」ではなく「豚肉」）
2. 単位は g / ml / 個 / 本 / 枚 / パック のいずれかに揃える
3. 分数は使わず小数で書く（例:「1/2個」ではなく「0.5個」）
4. 数字と単位は全角ではなく半角で書く
5. 調味料（醤油・みりん・砂糖・塩・油・だし等）は食材名の先頭に # を付ける
6. 1つの欄に複数の食材を書かない（「ごま油またはサラダ油」は不可。1食材1つ）

【例】
豚肉の生姜焼き: 豚肉 200g, 玉ねぎ 0.5個, #醤油 大さじ1, #みりん 大さじ1
分量が不明な場合は食材名だけでもOKです。`;

// ===================================================================
// 食材行のUI（コンポーネントをHome外に定義することでリセットを防ぐ）
// ===================================================================
function IngredientRowsInput({
  rows,
  onChange,
  onToggleSeasoning,
  onAdd,
  onRemove,
  suggestions,
  listId,
}: {
  rows: IngredientRow[];
  onChange: (index: number, field: "name" | "amount", value: string) => void;
  onToggleSeasoning: (index: number) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  /** 登録済みの食材名（表記を揃えるための入力候補） */
  suggestions: string[];
  listId: string;
}) {
  return (
    <div className="ingredient-rows">
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      {rows.map((row, idx) => (
        <div key={idx} className="ingredient-row">
          <input
            type="text"
            list={listId}
            autoComplete="off"
            placeholder="食材名（例: 豚肉）"
            value={row.name}
            onChange={(e) => onChange(idx, "name", e.target.value)}
          />
          <input
            type="text"
            placeholder={row.isSeasoning ? "量（任意）" : "量（例: 200g）"}
            value={row.amount}
            onChange={(e) => onChange(idx, "amount", e.target.value)}
            className="amount-input"
          />
          <button
            type="button"
            className={`btn-seasoning ${row.isSeasoning ? "active" : ""}`}
            onClick={() => onToggleSeasoning(idx)}
            title={row.isSeasoning ? "調味料（買い物リストで数量を集計しません）" : "調味料にする"}
            aria-pressed={row.isSeasoning}
          >
            調
          </button>
          {rows.length > 1 && (
            <button
              type="button"
              className="btn-remove-row"
              onClick={() => onRemove(idx)}
              aria-label="この行を削除"
            >
              ×
            </button>
          )}
        </div>
      ))}
      <button type="button" className="btn-add-row" onClick={onAdd}>
        ＋ 食材を追加
      </button>
      <p className="ingredient-hint">
        「調」を押すと調味料になり、買い物リストで数量を集計しません。
        {suggestions.length > 0 && `　食材名を打つと、登録済みの${suggestions.length}件から候補が出ます。`}
      </p>
    </div>
  );
}

export default function Home() {
  // --- 状態管理 ---
  const [menus, setMenus] = useState<Menu[]>([]);
  const [newMenuName, setNewMenuName] = useState("");
  const [newIngredientRows, setNewIngredientRows] = useState<IngredientRow[]>([emptyRow()]);
  const [newMemo, setNewMemo] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoaded, setIsLoaded] = useState(false);

  const [selectedMenuId, setSelectedMenuId] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editIngredientRows, setEditIngredientRows] = useState<IngredientRow[]>([emptyRow()]);
  const [editMemo, setEditMemo] = useState("");

  const [showBulkImport, setShowBulkImport] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [imagePreviews, setImagePreviews] = useState<string[]>([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractError, setExtractError] = useState("");
  const [remaining, setRemaining] = useState<number | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);

  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedMenuIds, setSelectedMenuIds] = useState<string[]>([]);
  const [showShoppingList, setShowShoppingList] = useState(false);
  const [editableShoppingList, setEditableShoppingList] = useState<ShoppingItem[]>([]);
  const [isEditingShoppingList, setIsEditingShoppingList] = useState(false);

  // --- 調味料の自動判定（組み込み辞書＋登録済みデータからの学習） ---
  const learnedSeasonings = useMemo(() => {
    const set = new Set<string>();
    menus.forEach((menu) => {
      menu.ingredients.forEach((ing) => {
        const p = parseIngredient(ing);
        const n = p.name.trim();
        if (p.isSeasoning && n) set.add(n);
      });
    });
    return set;
  }, [menus]);

  // --- 登録済みの食材名（入力候補＋呪文への差し込み用。使用回数の多い順） ---
  const ingredientStats = useMemo(() => {
    const map = new Map<string, { count: number; seasoning: number }>();
    menus.forEach((menu) => {
      menu.ingredients.forEach((ing) => {
        const p = parseIngredient(ing);
        const n = p.name.trim();
        if (!n) return;
        const cur = map.get(n) ?? { count: 0, seasoning: 0 };
        cur.count += 1;
        if (p.isSeasoning) cur.seasoning += 1;
        map.set(n, cur);
      });
    });
    return [...map.entries()]
      .map(([name, v]) => ({
        name,
        count: v.count,
        // 半数以上が調味料として登録されている、または組み込み辞書にあれば調味料とみなす
        isSeasoning: v.seasoning * 2 >= v.count || SEASONINGS.includes(name),
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ja"));
  }, [menus]);

  const nameSuggestions = useMemo(() => ingredientStats.map((s) => s.name), [ingredientStats]);

  const isKnownSeasoning = (name: string): boolean => {
    const n = name.trim();
    if (!n) return false;
    return SEASONINGS.includes(n) || learnedSeasonings.has(n);
  };

  // --- データの取得とリアルタイム購読 ---
  const fetchMenus = async (): Promise<boolean> => {
    const { data, error } = await supabase
      .from("menus")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("データの取得に失敗しました（localStorageのデータを使用）:", error);
      return false;
    }
    if (data) {
      setMenus(data);
      localStorage.setItem("menus", JSON.stringify(data));
    }
    return true;
  };

  // menus が変わるたびに localStorage に保存
  useEffect(() => {
    if (isLoaded) {
      localStorage.setItem("menus", JSON.stringify(menus));
    }
  }, [menus, isLoaded]);

  useEffect(() => {
    // まず localStorage から即座に読み込む
    try {
      const saved = localStorage.getItem("menus");
      if (saved) {
        setMenus(JSON.parse(saved));
      }
    } catch {
      // localStorage が読めない場合は無視
    }
    setIsLoaded(true);

    // 次に Supabase から最新データを取得（失敗しても localStorage のデータが残る）
    fetchMenus();

    const channel = supabase
      .channel("realtime-menus")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "menus" },
        () => { fetchMenus(); }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  // --- 食材行の操作 ---
  const makeRowUpdater =
    (setter: React.Dispatch<React.SetStateAction<IngredientRow[]>>) =>
    (index: number, field: "name" | "amount", value: string) => {
      setter((prev) =>
        prev.map((row, i) => {
          if (i !== index) return row;
          const next: IngredientRow = { ...row, [field]: value };
          // 食材名を入れた時点で、辞書・学習結果に一致すれば調味料を自動ON（手動操作済みなら尊重）
          if (field === "name" && !row.touched) {
            next.isSeasoning = isKnownSeasoning(value);
          }
          return next;
        })
      );
    };

  const makeSeasoningToggler =
    (setter: React.Dispatch<React.SetStateAction<IngredientRow[]>>) => (index: number) => {
      setter((prev) =>
        prev.map((row, i) =>
          i === index ? { ...row, isSeasoning: !row.isSeasoning, touched: true } : row
        )
      );
    };

  const updateNewIngredientRow = makeRowUpdater(setNewIngredientRows);
  const toggleNewSeasoning = makeSeasoningToggler(setNewIngredientRows);
  const addNewIngredientRow = () => setNewIngredientRows((prev) => [...prev, emptyRow()]);
  const removeNewIngredientRow = (index: number) =>
    setNewIngredientRows((prev) => prev.filter((_, i) => i !== index));

  const updateEditIngredientRow = makeRowUpdater(setEditIngredientRows);
  const toggleEditSeasoning = makeSeasoningToggler(setEditIngredientRows);
  const addEditIngredientRow = () => setEditIngredientRows((prev) => [...prev, emptyRow()]);
  const removeEditIngredientRow = (index: number) =>
    setEditIngredientRows((prev) => prev.filter((_, i) => i !== index));

  // --- イベントハンドラ ---

  // 単体登録
  const handleAddMenu = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMenuName.trim()) return;

    const ingredientsArray = newIngredientRows
      .map(formatIngredient)
      .filter((s) => s !== "");

    const newMenu = {
      id: crypto.randomUUID(),
      name: newMenuName.trim(),
      ingredients: ingredientsArray,
      memo: newMemo.trim(),
    };

    setMenus([newMenu, ...menus]);

    const { error } = await supabase.from("menus").insert([newMenu]);
    if (error) {
      console.error("保存エラー:", error);
      alert("保存に失敗しました。");
      fetchMenus();
    }

    setNewMenuName("");
    setNewIngredientRows([emptyRow()]);
    setNewMemo("");
  };

  // 一括登録
  const handleBulkAdd = async () => {
    if (!bulkText.trim()) return;

    const lines = bulkText.split("\n");
    const newMenus: Menu[] = [];

    lines.forEach((line) => {
      if (!line.trim()) return;
      const parts = line.split(/[:：]/);
      const name = parts[0].trim();
      if (!name) return;

      const ingredientsStr = parts.length > 1 ? parts[1] : "";
      // "豚肉 200g" → "豚肉:200g" / "#醤油 大さじ1" → "#醤油:大さじ1"
      const ingredientsArray = ingredientsStr
        .split(/[,、]+/)
        .map((ing) => {
          let trimmed = ing.trim();
          if (!trimmed) return "";

          // 先頭の # を調味料マーカーとして解釈
          let isSeasoning = false;
          if (trimmed.startsWith(SEASONING_PREFIX)) {
            isSeasoning = true;
            trimmed = trimmed.slice(SEASONING_PREFIX.length).trim();
          }
          if (!trimmed) return "";

          const spaceIdx = trimmed.search(/\s+/);
          const ingName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx).trim();
          const ingAmount = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx).trim();

          // # が付いていなくても、辞書・学習結果に一致すれば調味料として登録
          if (!isSeasoning && isKnownSeasoning(ingName)) isSeasoning = true;

          return formatIngredient({ name: ingName, amount: ingAmount, isSeasoning });
        })
        .filter((ing) => ing !== "");

      newMenus.push({ id: crypto.randomUUID(), name, ingredients: ingredientsArray });
    });

    if (newMenus.length > 0) {
      setMenus([...newMenus, ...menus]);
      setBulkText("");
      setShowBulkImport(false);
      alert(`${newMenus.length}件のメニューを一括登録します！`);

      const { error } = await supabase.from("menus").insert(newMenus);
      if (error) {
        console.error("一括保存エラー:", error);
        fetchMenus();
      }
    }
  };

  // 画像選択（既存の選択に追加する。分割レシピを上から順に足していける）
  const handleImageChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = ""; // 同じファイルを再選択できるようにリセット
    if (picked.length === 0) return;

    setExtractError("");

    const room = MAX_IMAGES - imageFiles.length;
    if (room <= 0) {
      setExtractError(`画像は${MAX_IMAGES}枚までです。`);
      return;
    }

    const accepted = picked.slice(0, room);
    const nextFiles = [...imageFiles, ...accepted];

    const totalBytes = nextFiles.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      setExtractError(
        "画像の合計サイズが大きすぎます（4MBまで）。枚数を減らすか、小さい画像を使ってください。"
      );
      return;
    }

    const previews = await Promise.all(accepted.map(readAsDataURL));
    setImageFiles(nextFiles);
    setImagePreviews((prev) => [...prev, ...previews]);

    if (picked.length > accepted.length) {
      setExtractError(
        `画像は${MAX_IMAGES}枚までです。先頭の${accepted.length}枚だけ追加しました。`
      );
    }
  };

  // 選んだ画像を1枚取り消す
  const handleRemoveImage = (index: number) => {
    setImageFiles((prev) => prev.filter((_, i) => i !== index));
    setImagePreviews((prev) => prev.filter((_, i) => i !== index));
    setExtractError("");
  };

  // Geminiで画像から食材を自動抽出（複数枚は「1つのレシピの分割」として送る）
  const handleGeminiExtract = async () => {
    if (imageFiles.length === 0) return;
    setIsExtracting(true);
    setExtractError("");

    const formData = new FormData();
    imageFiles.forEach((file) => formData.append("images", file));

    try {
      const res = await fetch("/api/extract-menu", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        setExtractError(data.error ?? "エラーが発生しました。");
        return;
      }

      setBulkText(data.result);
      setRemaining(data.remaining);
      setImageFiles([]);
      setImagePreviews([]);
    } catch {
      setExtractError("通信エラーが発生しました。インターネット接続を確認してください。");
    } finally {
      setIsExtracting(false);
    }
  };

  // 呪文コピー（登録済みの食材名を末尾に差し込み、AIに表記を揃えさせる）
  const buildPromptText = (): string => {
    if (ingredientStats.length === 0) return BASE_PROMPT;
    const list = ingredientStats
      .slice(0, MAX_PROMPT_SUGGESTIONS)
      .map((s) => (s.isSeasoning ? SEASONING_PREFIX + s.name : s.name))
      .join(", ");
    return `${BASE_PROMPT}

【すでに登録済みの食材名】
${list}

上の一覧に同じ食材があれば、必ずその表記をそのまま使ってください。
一覧にないものだけ、新しく書いてください。`;
  };

  const handleCopyPrompt = () => {
    navigator.clipboard.writeText(buildPromptText()).then(() => {
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    });
  };

  // 削除
  const handleDeleteMenu = async (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (!window.confirm("この献立を削除しますか？")) return;

    setMenus(menus.filter((menu) => menu.id !== id));
    if (selectedMenuId === id) {
      setSelectedMenuId(null);
      setIsEditing(false);
    }

    const { error } = await supabase.from("menus").delete().eq("id", id);
    if (error) {
      console.error("削除エラー:", error);
      fetchMenus();
    }
  };

  // タグクリックで逆引き検索（食材名だけで検索）
  const handleTagClick = (ing: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSearchQuery(parseIngredient(ing).name);
    setSelectedMenuId(null);
    setIsEditing(false);
  };

  // 編集開始
  const startEditing = (menu: Menu) => {
    setEditName(menu.name);
    setEditIngredientRows(
      menu.ingredients.length > 0
        ? menu.ingredients.map((ing) => ({ ...parseIngredient(ing), touched: true }))
        : [emptyRow()]
    );
    setEditMemo(menu.memo || "");
    setIsEditing(true);
  };

  // 編集保存
  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editName.trim() || !selectedMenuId) return;

    const ingredientsArray = editIngredientRows
      .map(formatIngredient)
      .filter((s) => s !== "");

    setMenus(menus.map((menu) =>
      menu.id === selectedMenuId
        ? { ...menu, name: editName.trim(), ingredients: ingredientsArray, memo: editMemo.trim() }
        : menu
    ));

    setIsEditing(false);

    const { error } = await supabase
      .from("menus")
      .update({ name: editName.trim(), ingredients: ingredientsArray, memo: editMemo.trim() })
      .eq("id", selectedMenuId);

    if (error) {
      console.error("更新エラー:", error);
      fetchMenus();
    }
  };

  // 選択の切り替え
  const toggleSelectMenu = (id: string) => {
    setSelectedMenuIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  // 買い物リストの組み立て
  const buildShoppingList = (): ShoppingItem[] => {
    const normal = new Map<string, string[]>();
    const seasoning = new Set<string>();

    selectedMenuIds.forEach((id) => {
      const menu = menus.find((m) => m.id === id);
      if (!menu) return;
      menu.ingredients.forEach((ing) => {
        const { name, amount, isSeasoning } = parseIngredient(ing);
        const n = name.trim();
        if (!n) return;
        if (isSeasoning) {
          // 調味料は名前だけを集める（数量は集計しない）
          seasoning.add(n);
          return;
        }
        if (!normal.has(n)) normal.set(n, []);
        if (amount) normal.get(n)!.push(amount);
      });
    });

    const normalItems: ShoppingItem[] = [...normal.entries()]
      .map(([name, amounts]) => ({ name, total: sumAmounts(amounts), isSeasoning: false }))
      .sort((a, b) => a.name.localeCompare(b.name, "ja"));

    const seasoningItems: ShoppingItem[] = [...seasoning]
      .map((name) => ({ name, total: "", isSeasoning: true }))
      .sort((a, b) => a.name.localeCompare(b.name, "ja"));

    return [...normalItems, ...seasoningItems];
  };

  // 買い物リストをテキストとしてコピー
  const [shoppingCopySuccess, setShoppingCopySuccess] = useState(false);
  const handleCopyShoppingList = (list: ShoppingItem[]) => {
    const selectedMenuNames = selectedMenuIds
      .map(id => menus.find(m => m.id === id)?.name ?? "")
      .filter(Boolean)
      .join("、");

    const normals = list.filter((i) => i.name && !i.isSeasoning);
    const seasonings = list.filter((i) => i.name && i.isSeasoning);

    const lines: string[] = [`【買い物リスト】`, `（${selectedMenuNames}）`];

    if (normals.length > 0) {
      lines.push(``, `■ 食材`);
      normals.forEach((item) =>
        lines.push(item.total ? `□ ${item.name}　${item.total}` : `□ ${item.name}`)
      );
    }
    if (seasonings.length > 0) {
      lines.push(``, `■ 調味料（数量は集計していません）`);
      seasonings.forEach((item) => lines.push(`□ ${item.name}`));
    }

    navigator.clipboard.writeText(lines.join("\n")).then(() => {
      setShoppingCopySuccess(true);
      setTimeout(() => setShoppingCopySuccess(false), 2000);
    });
  };

  // 検索（食材名部分だけにマッチ）
  const filteredMenus = menus.filter((menu) => {
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase().trim();
    if (menu.name.toLowerCase().includes(query)) return true;
    if (menu.ingredients.some((ing) => parseIngredient(ing).name.toLowerCase().includes(query))) return true;
    return false;
  });

  if (!isLoaded) return null;

  const selectedMenu = selectedMenuId ? menus.find(m => m.id === selectedMenuId) : null;
  const shoppingNormals = editableShoppingList.filter((i) => i.name && !i.isSeasoning);
  const shoppingSeasonings = editableShoppingList.filter((i) => i.name && i.isSeasoning);

  return (
    <div className="container">
      <h1>🍳 我が家の献立ノート</h1>

      {showShoppingList ? (
        <div className="detail-view">
          <button
            className="btn-secondary"
            onClick={() => { setShowShoppingList(false); setIsSelectMode(false); setSelectedMenuIds([]); setIsEditingShoppingList(false); }}
          >
            ← 一覧に戻る
          </button>
          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
              <h2 style={{ marginBottom: 0 }}>🛒 買い物リスト</h2>
              <button
                className="btn-edit"
                onClick={() => setIsEditingShoppingList(!isEditingShoppingList)}
              >
                {isEditingShoppingList ? "完了" : "編集"}
              </button>
            </div>
            <p style={{ fontSize: "0.85rem", color: "var(--text-light)", marginBottom: "16px" }}>
              {selectedMenuIds.length}件のメニューから集計
            </p>

            {isEditingShoppingList ? (
              <div className="ingredient-rows">
                {editableShoppingList.map((item, idx) => (
                  <div key={idx} className="ingredient-row">
                    <input
                      type="text"
                      placeholder="食材名"
                      value={item.name}
                      onChange={(e) => setEditableShoppingList(prev => prev.map((x, i) => i === idx ? { ...x, name: e.target.value } : x))}
                    />
                    <input
                      type="text"
                      placeholder={item.isSeasoning ? "—" : "量"}
                      value={item.total}
                      onChange={(e) => setEditableShoppingList(prev => prev.map((x, i) => i === idx ? { ...x, total: e.target.value } : x))}
                      className="amount-input"
                    />
                    <button
                      type="button"
                      className={`btn-seasoning ${item.isSeasoning ? "active" : ""}`}
                      onClick={() => setEditableShoppingList(prev => prev.map((x, i) => i === idx ? { ...x, isSeasoning: !x.isSeasoning } : x))}
                      title="調味料に切り替え"
                      aria-pressed={item.isSeasoning}
                    >
                      調
                    </button>
                    <button
                      type="button"
                      className="btn-remove-row"
                      onClick={() => setEditableShoppingList(prev => prev.filter((_, i) => i !== idx))}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn-add-row"
                  onClick={() => setEditableShoppingList(prev => [...prev, { name: "", total: "", isSeasoning: false }])}
                >
                  ＋ 食材を追加
                </button>
              </div>
            ) : (
              <>
                {shoppingNormals.length === 0 && shoppingSeasonings.length === 0 ? (
                  <p style={{ color: "var(--text-light)" }}>食材が登録されていません</p>
                ) : (
                  <>
                    {shoppingNormals.length > 0 && (
                      <>
                        <h3 className="shopping-section-title">食材</h3>
                        <ul className="shopping-list">
                          {shoppingNormals.map((item, idx) => (
                            <li key={`n-${idx}`} className="shopping-item">
                              <span className="shopping-name">{item.name}</span>
                              {item.total && (
                                <span className="shopping-count">{item.total}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    {shoppingSeasonings.length > 0 && (
                      <>
                        <h3 className="shopping-section-title">
                          調味料<span className="shopping-section-note">数量は集計しません</span>
                        </h3>
                        <ul className="shopping-list">
                          {shoppingSeasonings.map((item, idx) => (
                            <li key={`s-${idx}`} className="shopping-item">
                              <span className="shopping-name">{item.name}</span>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </>
                )}
                <button
                  className="btn-copy-shopping"
                  onClick={() => handleCopyShoppingList(editableShoppingList.filter(item => item.name))}
                >
                  {shoppingCopySuccess ? "✓ コピーしました！" : "📋 テキストをコピーする"}
                </button>
              </>
            )}
          </div>
        </div>
      ) : selectedMenu ? (
        <div className="detail-view">
          <button
            className="btn-secondary"
            onClick={() => { setSelectedMenuId(null); setIsEditing(false); }}
          >
            ← 一覧に戻る
          </button>

          <div className="card">
            {isEditing ? (
              <form onSubmit={handleSaveEdit}>
                <div className="input-group">
                  <label htmlFor="editName">メニュー名</label>
                  <input
                    id="editName"
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    required
                  />
                </div>
                <div className="input-group">
                  <label>使う食材と量</label>
                  <IngredientRowsInput
                    rows={editIngredientRows}
                    onChange={updateEditIngredientRow}
                    onToggleSeasoning={toggleEditSeasoning}
                    onAdd={addEditIngredientRow}
                    onRemove={removeEditIngredientRow}
                    suggestions={nameSuggestions}
                    listId="ingredient-options-edit"
                  />
                </div>
                <div className="input-group">
                  <label htmlFor="editMemo">備考・工程メモ (任意)</label>
                  <textarea
                    id="editMemo"
                    value={editMemo}
                    onChange={(e) => setEditMemo(e.target.value)}
                  />
                </div>
                <div className="button-group">
                  <button type="button" className="btn-secondary" style={{ marginBottom: 0 }} onClick={() => setIsEditing(false)}>
                    キャンセル
                  </button>
                  <button type="submit" className="btn-primary" style={{ flex: 1 }}>
                    変更を保存する
                  </button>
                </div>
              </form>
            ) : (
              <>
                <h2>{selectedMenu.name}</h2>
                <div className="detail-section">
                  <h3>使う食材</h3>
                  {selectedMenu.ingredients.length > 0 ? (
                    <table className="ingredient-table">
                      <thead>
                        <tr>
                          <th>食材</th>
                          <th>量</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedMenu.ingredients.map((ing, idx) => {
                          const { name, amount, isSeasoning } = parseIngredient(ing);
                          return (
                            <tr key={idx}>
                              <td>
                                <span
                                  className={`tag ${isSeasoning ? "tag-seasoning" : ""}`}
                                  onClick={(e) => handleTagClick(ing, e)}
                                  title={`${name} で検索`}
                                >
                                  {name}
                                </span>
                                {isSeasoning && <span className="seasoning-badge">調味料</span>}
                              </td>
                              <td className="amount-cell">{amount || "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : (
                    <p style={{ color: "var(--text-light)" }}>登録されていません</p>
                  )}
                </div>

                <div className="detail-section">
                  <h3>備考・工程メモ</h3>
                  {selectedMenu.memo ? (
                    <div className="detail-memo">{selectedMenu.memo}</div>
                  ) : (
                    <p style={{ color: "var(--text-light)" }}>メモはありません</p>
                  )}
                </div>

                <div className="detail-actions">
                  <button className="btn-edit" onClick={() => startEditing(selectedMenu)}>
                    この献立を編集する
                  </button>
                  <button className="btn-delete" onClick={(e) => handleDeleteMenu(selectedMenu.id, e)}>
                    削除
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="card">
            <h2>✨ 新しい献立を登録</h2>
            <form onSubmit={handleAddMenu}>
              <div className="input-group">
                <label htmlFor="menuName">メニュー名</label>
                <input
                  id="menuName"
                  type="text"
                  placeholder="例: 豚肉の生姜焼き"
                  value={newMenuName}
                  onChange={(e) => setNewMenuName(e.target.value)}
                  required
                />
              </div>
              <div className="input-group">
                <label>使う食材と量</label>
                <IngredientRowsInput
                  rows={newIngredientRows}
                  onChange={updateNewIngredientRow}
                  onToggleSeasoning={toggleNewSeasoning}
                  onAdd={addNewIngredientRow}
                  onRemove={removeNewIngredientRow}
                  suggestions={nameSuggestions}
                  listId="ingredient-options-new"
                />
              </div>
              <button type="submit" className="btn-primary">
                1件ずつ登録する
              </button>
            </form>

            <div className="bulk-import-section">
              <button
                className="bulk-import-toggle"
                onClick={() => setShowBulkImport(!showBulkImport)}
              >
                {showBulkImport ? "▲ 一括登録を閉じる" : "▼ AIを使ってまとめて一括登録する"}
              </button>

              {showBulkImport && (
                <div style={{ marginTop: "16px" }}>

                  {/* === Gemini 自動抽出エリア === */}
                  <div className="prompt-box">
                    <p><strong>📷 画像から自動抽出（Gemini AI）</strong></p>
                    <p style={{ marginTop: "6px", fontSize: "0.85rem" }}>
                      レシピや献立表の写真を選ぶと、メニュー名と食材を自動で読み取ります。
                    </p>
                    <p style={{ marginTop: "4px", fontSize: "0.8rem", color: "var(--text-light)" }}>
                      1つのレシピが複数の画像に分かれている場合は、<strong>上から順に</strong>最大{MAX_IMAGES}枚まで選べます。
                      2枚以上のときは<strong>1つの献立</strong>としてまとめて読み取ります。
                    </p>

                    {/* 画像アップロードエリア（選択済みはサムネイル、末尾に追加タイル） */}
                    {imagePreviews.length === 0 ? (
                      <div
                        className="image-upload-area"
                        onClick={() => document.getElementById("imageInput")?.click()}
                      >
                        <div className="image-upload-placeholder">
                          <span style={{ fontSize: "2rem" }}>📷</span>
                          <span>タップして画像を選択</span>
                        </div>
                      </div>
                    ) : (
                      <div className="image-thumb-grid">
                        {imagePreviews.map((src, i) => (
                          <div key={i} className="image-thumb">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={src} alt={`選択中の画像${i + 1}`} />
                            <span className="image-thumb-index">{i + 1}</span>
                            <button
                              type="button"
                              className="image-thumb-remove"
                              onClick={() => handleRemoveImage(i)}
                              aria-label={`画像${i + 1}を削除`}
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                        {imagePreviews.length < MAX_IMAGES && (
                          <button
                            type="button"
                            className="image-thumb-add"
                            onClick={() => document.getElementById("imageInput")?.click()}
                          >
                            <span style={{ fontSize: "1.5rem" }}>＋</span>
                            <span style={{ fontSize: "0.75rem" }}>追加</span>
                          </button>
                        )}
                      </div>
                    )}
                    <input
                      id="imageInput"
                      type="file"
                      accept="image/*"
                      multiple
                      style={{ display: "none" }}
                      onChange={handleImageChange}
                    />

                    {imageFiles.length > 0 && (
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={handleGeminiExtract}
                        disabled={isExtracting}
                        style={{ marginTop: "12px" }}
                      >
                        {isExtracting
                          ? "⏳ AIが読み取り中..."
                          : imageFiles.length === 1
                          ? "✨ Geminiで自動抽出する"
                          : `✨ ${imageFiles.length}枚を1つの献立として読み取る`}
                      </button>
                    )}

                    {extractError && (
                      <p style={{ color: "#ff4a4a", fontSize: "0.85rem", marginTop: "8px" }}>
                        {extractError}
                      </p>
                    )}

                    {remaining !== null && (
                      <p style={{ fontSize: "0.78rem", color: "var(--text-light)", marginTop: "8px" }}>
                        本日の残り利用回数: {remaining} / 20
                      </p>
                    )}
                  </div>

                  {/* === 手動入力（折りたたみ） === */}
                  <details style={{ marginTop: "12px" }}>
                    <summary className="bulk-import-toggle" style={{ padding: "8px 0" }}>
                      手動で貼り付ける場合（AI呪文コピー）
                    </summary>
                    <div style={{ marginTop: "12px" }} className="prompt-box">
                      <p><strong>AIへの指示文（プロンプト）</strong></p>
                      <p style={{ marginTop: "4px", fontSize: "0.85rem" }}>
                        レシピ画像をChatGPT等に送り、以下の呪文をコピーして貼り付けてください。
                      </p>
                      <code>{BASE_PROMPT}</code>
                      {ingredientStats.length > 0 && (
                        <p className="prompt-note">
                          コピーすると、登録済みの食材名{Math.min(ingredientStats.length, MAX_PROMPT_SUGGESTIONS)}件が自動で追記されます。
                        </p>
                      )}
                      <button className="btn-copy" onClick={handleCopyPrompt}>
                        {copySuccess ? "✓ コピーしました！" : "呪文をコピーする"}
                      </button>
                    </div>
                  </details>

                  {/* === 結果テキスト（確認・修正可能） === */}
                  <div className="input-group" style={{ marginTop: "16px" }}>
                    <label>抽出結果を確認・修正してから登録（編集できます）</label>
                    <textarea
                      placeholder="豚肉の生姜焼き: 豚肉 200g, 玉ねぎ 0.5個, #醤油 大さじ1&#13;&#10;カレーライス: 豚肉 300g, じゃがいも 2個, にんじん 1本"
                      value={bulkText}
                      onChange={(e) => setBulkText(e.target.value)}
                      style={{ minHeight: "120px" }}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn-primary"
                    style={{ backgroundColor: "#ffb443" }}
                    onClick={handleBulkAdd}
                  >
                    まとめて登録する！
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <h2>🔍 食材から献立を探す</h2>
            <div className="input-group" style={{ marginBottom: 0 }}>
              <input
                type="text"
                placeholder="例: 豚肉、にんじん..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            {searchQuery && (
              <button
                className="btn-secondary"
                style={{ marginTop: "12px", width: "100%" }}
                onClick={() => setSearchQuery("")}
              >
                検索をクリア
              </button>
            )}
          </div>

          <div className="select-mode-header">
            <button
              className={`btn-select-toggle ${isSelectMode ? "active" : ""}`}
              onClick={() => { setIsSelectMode(!isSelectMode); setSelectedMenuIds([]); }}
            >
              {isSelectMode ? "キャンセル" : "🛒 買い物リストを作る"}
            </button>
          </div>

          <div className="menu-list">
            {filteredMenus.length === 0 ? (
              <div className="empty-state">
                {searchQuery
                  ? "一致する献立が見つかりません"
                  : "まだ献立が登録されていません。上のフォームから追加してみましょう！"}
              </div>
            ) : (
              filteredMenus.map((menu) => {
                const isChecked = selectedMenuIds.includes(menu.id);
                return (
                  <div
                    key={menu.id}
                    className={`menu-item ${isSelectMode && isChecked ? "selected" : ""}`}
                    onClick={() => isSelectMode ? toggleSelectMenu(menu.id) : setSelectedMenuId(menu.id)}
                  >
                    {isSelectMode && (
                      <div className="menu-checkbox">
                        <span className={`checkbox-icon ${isChecked ? "checked" : ""}`}>
                          {isChecked ? "✓" : ""}
                        </span>
                      </div>
                    )}
                    <div className="menu-info">
                      <h3>{menu.name}</h3>
                      {menu.ingredients.length > 0 && (
                        <div className="tag-list">
                          {menu.ingredients.map((ing, idx) => {
                            const p = parseIngredient(ing);
                            return (
                              <span
                                key={idx}
                                className={`tag ${p.isSeasoning ? "tag-seasoning" : ""}`}
                                onClick={(e) => { if (!isSelectMode) handleTagClick(ing, e); }}
                              >
                                {p.name}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    {!isSelectMode && (
                      <button
                        onClick={(e) => handleDeleteMenu(menu.id, e)}
                        className="btn-delete"
                        aria-label="削除"
                      >
                        削除
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {isSelectMode && selectedMenuIds.length > 0 && (
            <div className="select-bar">
              <span>{selectedMenuIds.length}件選択中</span>
              <button className="btn-primary" style={{ width: "auto", padding: "12px 24px" }} onClick={() => { setEditableShoppingList(buildShoppingList()); setShowShoppingList(true); }}>
                買い物リストを作る →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

type ShoppingItem = { name: string; total: string; isSeasoning: boolean };
