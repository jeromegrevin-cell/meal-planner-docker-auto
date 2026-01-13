import { useEffect, useState } from "react";
import axios from "axios";

function TokensGraph({ data }) {
  if (!data?.length) return null;

  const max = Math.max(...data.map(d => d.total_tokens), 1);

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        Évolution des tokens par semaine
      </div>
      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "flex-end",
          height: 80,
          borderBottom: "1px solid #ddd",
          paddingBottom: 4
        }}
      >
        {data.map(w => (
          <div
            key={w.week_id}
            title={`${w.week_id} : ${w.total_tokens} tokens`}
            style={{
              width: 22,
              height: `${(w.total_tokens / max) * 100}%`,
              background: "#6366f1",
              borderRadius: 4
            }}
          />
        ))}
      </div>
    </div>
  );
}

export default function TokensUsage() {
  const [weekId, setWeekId] = useState(null);
  const [tokenWeek, setTokenWeek] = useState(0);
  const [tokenCumul, setTokenCumul] = useState(0);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      setLoading(true);

      // 1) semaine courante = dernière semaine connue
      const { data: all } = await axios.get("/api/chat/usage/all");

      if (all.length > 0) {
        const current = all[all.length - 1];
        setWeekId(current.week_id);

        const { data: week } = await axios.get(
          `/api/chat/usage?week_id=${current.week_id}`
        );

        setTokenWeek(week?.usage_totals?.total_tokens ?? 0);

        const cumul = all.reduce(
          (sum, w) => sum + (w.total_tokens || 0),
          0
        );
        setTokenCumul(cumul);
        setHistory(all);
      }

      setLoading(false);
    }

    load();
  }, []);

  return (
    <div style={{ padding: 24 }}>
      <h2>Tokens & Usage</h2>

      {loading ? (
        <div>Chargement…</div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 24, marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 12, color: "#555" }}>
                Tokens semaine {weekId}
              </div>
              <div style={{ fontSize: 22, fontWeight: 600 }}>
                {tokenWeek}
              </div>
            </div>

            <div>
              <div style={{ fontSize: 12, color: "#555" }}>
                Tokens cumul
              </div>
              <div style={{ fontSize: 22, fontWeight: 600 }}>
                {tokenCumul}
              </div>
            </div>
          </div>

          <TokensGraph data={history} />
        </>
      )}
    </div>
  );
}
