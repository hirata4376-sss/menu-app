"use client";

import { useState, useEffect } from "react";
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
};

// 食材行のUI（コンポーネントをHome外に定義することでリセットを防ぐ）
function IngredientRowsInput({
  rows,
  onChange,
  onAdd,
  onRemove,
}: {
  rows: IngredientRow[];
  onChange: (index: number, field: keyof IngredientRow, value: string) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}) {
  return (
    <div className="ingredient-rows">
      {rows.map((row, idx) => (
        <div key={idx} className="ingredient-row">
          <input
            type="text"
            placeholder="食材名（例: 豚肉）"
            value={row.name}
            onChange={(e) => onChange(idx, "name", e.target.value)}
          />
          <input
            type="text"
            placeholder="量（例: 200g）"
            value={row.amount}
            onChange={(e) => onChange(idx, "amount", e.target.value)}
            className="amount-input"
          />
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
    </div>
  );
}

// "豚肉:200g" → { name: "豚肉", amount: "200g" }
const parseIngredient = (str: string): IngredientRow => {
  const idx = str.indexOf(":");
  if (idx === -1) return { name: str, amount: "" };
  return { name: str.slice(0, idx), amount: str.slice(idx + 1) };
};

// { name: "豚肉", amount: "200g" } → "豚肉:200g"
const formatIngredient = (row: IngredientRow): string => {
  const name = row.name.trim();
  const amount = row.amount.trim();
  if (!name) return "";
  return amount ? `${name}:${amount}` : name;
};

export default function Home() {
  // --- 状態管理 ---
  const [menus, setMenus] = useState<Menu[]>([]);
  const [newMenuName, setNewMenuName] = useState("");
  const [newIngredientRows, setNewIngredientRows] = useState<IngredientRow[]>([{ name: "", amount: "" }]);
  const [newMemo, setNewMemo] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoaded, setIsLoaded] = useState(false);

  const [selectedMenuId, setSelectedMenuId] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editIngredientRows, setEditIngredientRows] = useState<IngredientRow[]>([{ name: "", amount: "" }]);
  const [editMemo, setEditMemo] = useState("");

  const [showBulkImport, setShowBulkImport] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [copySuccess, setCopySuccess] = useState(false);

  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedMenuIds, setSelectedMenuIds] = useState<string[]>([]);
  const [showShoppingList, setShowShoppingList] = useState(false);
  const [editableShoppingList, setEditableShoppingList] = useState<{ name: string; total: string }[]>([]);
  const [isEditingShoppingList, setIsEditingShoppingList] = useState(false);

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
  const updateNewIngredientRow = (index: number, field: keyof IngredientRow, value: string) => {
    setNewIngredientRows(prev => prev.map((row, i) => i === index ? { ...row, [field]: value } : row));
  };
  const addNewIngredientRow = () => setNewIngredientRows(prev => [...prev, { name: "", amount: "" }]);
  const removeNewIngredientRow = (index: number) => setNewIngredientRows(prev => prev.filter((_, i) => i !== index));

  const updateEditIngredientRow = (index: number, field: keyof IngredientRow, value: string) => {
    setEditIngredientRows(prev => prev.map((row, i) => i === index ? { ...row, [field]: value } : row));
  };
  const addEditIngredientRow = () => setEditIngredientRows(prev => [...prev, { name: "", amount: "" }]);
  const removeEditIngredientRow = (index: number) => setEditIngredientRows(prev => prev.filter((_, i) => i !== index));

  // --- イベントハンドラ ---

  // 単体登録
  const handleAddMenu = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMenuName.trim()) return;

    const ingredientsArray = newIngredientRows
      .map(formatIngredient)
      .filter(s => s !== "");

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
    setNewIngredientRows([{ name: "", amount: "" }]);
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
      // "豚肉 200g" → "豚肉:200g" に変換して保存
      const ingredientsArray = ingredientsStr
        .split(/[,、]+/)
        .map((ing) => {
          const trimmed = ing.trim();
          if (!trimmed) return "";
          const spaceIdx = trimmed.search(/\s+/);
          if (spaceIdx === -1) return trimmed; // 量なし
          const ingName = trimmed.slice(0, spaceIdx).trim();
          const ingAmount = trimmed.slice(spaceIdx).trim();
          return ingAmount ? `${ingName}:${ingAmount}` : ingName;
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

  // 呪文コピー
  const handleCopyPrompt = () => {
    const promptText = `以下の画像（またはテキスト）から料理のメニュー名と、使われている主な食材・分量を抽出してください。
出力形式は必ず以下の「1行1メニュー」の形式でお願いします。余計な文章は不要です。

【出力フォーマット】
メニュー名: 食材1 分量1, 食材2 分量2, 食材3 分量3

【例】
豚肉の生姜焼き: 豚肉 200g, 玉ねぎ 1個, 生姜 1かけ
分量が不明な場合は食材名だけでもOKです。`;

    navigator.clipboard.writeText(promptText).then(() => {
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
        ? menu.ingredients.map(parseIngredient)
        : [{ name: "", amount: "" }]
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
      .filter(s => s !== "");

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

  // 買い物リストの組み立て（食材ごとに数量を合計）
  type ShoppingItem = { name: string; total: string };
  const buildShoppingList = (): ShoppingItem[] => {
    const map = new Map<string, string[]>();
    selectedMenuIds.forEach(id => {
      const menu = menus.find(m => m.id === id);
      if (!menu) return;
      menu.ingredients.forEach(ing => {
        const { name, amount } = parseIngredient(ing);
        if (!name) return;
        if (!map.has(name)) map.set(name, []);
        if (amount) map.get(name)!.push(amount);
      });
    });

    return Array.from(map.entries())
      .map(([name, amounts]) => {
        if (amounts.length === 0) return { name, total: "" };
        // 数字部分を合計し、単位は最初のものを流用
        let sum = 0;
        let unit = "";
        for (const a of amounts) {
          const m = a.match(/^(\d+(?:\.\d+)?)(.*)/);
          if (m) {
            sum += parseFloat(m[1]);
            if (!unit) unit = m[2].trim();
          }
        }
        const total = sum > 0
          ? `${Number.isInteger(sum) ? sum : sum}${unit}`
          : amounts.join(", ");
        return { name, total };
      })
      .sort((a, b) => a.name.localeCompare(b.name, "ja"));
  };

  // 買い物リストをテキストとしてコピー
  const [shoppingCopySuccess, setShoppingCopySuccess] = useState(false);
  const handleCopyShoppingList = (list: ShoppingItem[]) => {
    const selectedMenuNames = selectedMenuIds
      .map(id => menus.find(m => m.id === id)?.name ?? "")
      .filter(Boolean)
      .join("、");
    const lines = [
      `【買い物リスト】`,
      `（${selectedMenuNames}）`,
      ``,
      ...list.map(item => item.total ? `□ ${item.name}　${item.total}` : `□ ${item.name}`),
    ];
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
              <>
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
                        placeholder="量"
                        value={item.total}
                        onChange={(e) => setEditableShoppingList(prev => prev.map((x, i) => i === idx ? { ...x, total: e.target.value } : x))}
                        className="amount-input"
                      />
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
                    onClick={() => setEditableShoppingList(prev => [...prev, { name: "", total: "" }])}
                  >
                    ＋ 食材を追加
                  </button>
                </div>
              </>
            ) : (
              <>
                {editableShoppingList.length === 0 ? (
                  <p style={{ color: "var(--text-light)" }}>食材が登録されていません</p>
                ) : (
                  <ul className="shopping-list">
                    {editableShoppingList.filter(item => item.name).map((item, idx) => (
                      <li key={idx} className="shopping-item">
                        <span className="shopping-name">{item.name}</span>
                        {item.total && (
                          <span className="shopping-count">{item.total}</span>
                        )}
                      </li>
                    ))}
                  </ul>
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
                    onAdd={addEditIngredientRow}
                    onRemove={removeEditIngredientRow}
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
                          const { name, amount } = parseIngredient(ing);
                          return (
                            <tr key={idx}>
                              <td>
                                <span
                                  className="tag"
                                  onClick={(e) => handleTagClick(ing, e)}
                                  title={`${name} で検索`}
                                >
                                  {name}
                                </span>
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
                  onAdd={addNewIngredientRow}
                  onRemove={removeNewIngredientRow}
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
                  <div className="prompt-box">
                    <p><strong>1. AIへの指示文（プロンプト）</strong></p>
                    <p>レシピの画像をChatGPT等に送り、以下の呪文をコピーして貼り付けてください。</p>
                    <code>
                      以下の画像から料理のメニュー名と、使われている主な食材・分量を抽出してください。出力形式は必ず以下の「1行1メニュー」の形式でお願いします。余計な文章は不要です。<br/>
                      【出力フォーマット】<br/>
                      メニュー名: 食材1 分量1, 食材2 分量2, 食材3 分量3<br/>
                      【例】<br/>
                      豚肉の生姜焼き: 豚肉 200g, 玉ねぎ 1個, 生姜 1かけ<br/>
                      分量が不明な場合は食材名だけでもOKです。
                    </code>
                    <button className="btn-copy" onClick={handleCopyPrompt}>
                      {copySuccess ? "✓ コピーしました！" : "呪文をコピーする"}
                    </button>
                  </div>

                  <div className="input-group">
                    <label>2. AIからの返答をここに貼り付け</label>
                    <textarea
                      placeholder="豚肉の生姜焼き: 豚肉 200g, 玉ねぎ 1個, 生姜 1かけ&#13;&#10;カレーライス: 豚肉 300g, じゃがいも 2個, にんじん 1本"
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
                          {menu.ingredients.map((ing, idx) => (
                            <span
                              key={idx}
                              className="tag"
                              onClick={(e) => { if (!isSelectMode) handleTagClick(ing, e); }}
                            >
                              {parseIngredient(ing).name}
                            </span>
                          ))}
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
