// supabase/functions/keep_alive/index.ts
// Deploy this Edge Function in Supabase to prevent the free tier 7-day inactivity pause.
// Set a daily cron schedule (e.g. 0 8 * * *) or invoke via any free webhook/ping service.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async () => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! || Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Simple light query to keep the database active
    const { data, error } = await supabase
      .from("zong_global")
      .select("id, revision, updated_at")
      .eq("id", "main")
      .single();

    if (error) throw error;

    return new Response(
      JSON.stringify({ ok: true, timestamp: new Date().toISOString(), data }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
