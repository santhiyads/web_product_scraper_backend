const axios = require("axios");
const cheerio = require("cheerio");
const Company = require("../models/company.model");

/* ---------------- HELPERS ---------------- */

async function fetchDeepPages(baseUrl) {
  const paths = ["/about", "/about-us", "/contact", "/contact-us"];
  const pages = [];

  for (const path of paths) {
    try {
      const url = baseUrl.replace(/\/$/, "") + path;
      const res = await axios.get(url, {
        timeout: 10000,
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      pages.push({ url, html: res.data });
    } catch {
      // ignore failures
    }
  }

  return pages;
}

function extractEmail(text) {
  const match = text.match(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/
  );
  return match ? match[0] : null;
}

function extractPhones(text) {
  const matches = text.match(/(\+91[\s\-]?)?[6-9]\d{9}/g) || [];
  const set = new Set();

  for (let p of matches) {
    let digits = p.replace(/\D/g, "");
    if (digits.startsWith("91") && digits.length === 12) {
      digits = digits.slice(2);
    }
    if (digits.length === 10) {
      set.add("+91" + digits);
    }
  }

  return Array.from(set);
}

function safeMerge(original, incoming) {
  return original ?? incoming ?? null;
}

/* ---------------- CONTROLLER ---------------- */

exports.scrapeCompany = async (req, res) => {
  const startTime = Date.now();

  try {
    const { website } = req.body;

    if (!website) {
      return res.status(200).json({
        success: false,
        status: "failed",
        data: null,
        error: {
          code: "VALIDATION_ERROR",
          message: "website is required"
        }
      });
    }

    /* -------- HOMEPAGE -------- */

    const response = await axios.get(website, {
      timeout: 15000,
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const html = response.data;
    const $ = cheerio.load(html);

    let name =
      $("meta[property='og:site_name']").attr("content") ||
      $("title").text().trim() ||
      null;

    let about =
      $("meta[name='description']").attr("content") || null;

    const platform = html.includes("cdn.shopify.com")
      ? "shopify"
      : "unknown";

    let email = extractEmail($("body").text());
    let phones = extractPhones($("body").text());

    let location = null;
    $("address").each((_, el) => {
      const t = $(el).text().trim();
      if (t.length > 20 && /\d/.test(t)) location = t;
    });

    const socials = {};
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      if (href.includes("instagram.com")) socials.instagram ??= href;
      if (href.includes("facebook.com")) socials.facebook ??= href;
      if (href.includes("linkedin.com")) socials.linkedin ??= href;
      if (href.includes("wa.me") || href.includes("whatsapp"))
        socials.whatsapp ??= href;
    });

    /* -------- DEEP PAGES -------- */

    const deepPages = await fetchDeepPages(website);

    for (const page of deepPages) {
      const $p = cheerio.load(page.html);
      const text = $p("body").text();

      about = safeMerge(about, $p("meta[name='description']").attr("content"));
      email = safeMerge(email, extractEmail(text));

      const newPhones = extractPhones(text);
      if (phones.length === 0 && newPhones.length > 0) {
        phones = newPhones;
      }

      if (!location) {
        $p("address").each((_, el) => {
          const t = $p(el).text().trim();
          if (t.length > 20 && /\d/.test(t)) location = t;
        });
      }
    }

    /* -------- SCRAPE STATUS -------- */

    const scrapeStatus =
      name && about && about.length >= 50 ? "success" : "partial";

    /* -------- UPSERT -------- */

    const company = await Company.findOneAndUpdate(
      { website },
      {
        $set: {
          website,
          name,
          about,
          email,
          phones,
          location,
          socials,
          platform,
          scrapeStatus,
          lastScrapedAt: new Date()
        }
      },
      { upsert: true, new: true }
    );

    return res.status(200).json({
      success: true,
      status: scrapeStatus,
      data: company,
      error: null,
      meta: {
        source: "axios+deep-pages",
        durationMs: Date.now() - startTime
      }
    });

  } catch (err) {
    console.error("❌ Company scrape failed:", err.message);

    return res.status(200).json({
      success: false,
      status: "failed",
      data: null,
      error: {
        code: "SCRAPE_FAILED",
        message: "Unable to scrape company website"
      }
    });
  }
};
