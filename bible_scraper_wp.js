/*
 * Copyright (c) 2017 Adventech <info@adventech.io>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

var async = require("async"),
    redis = require("redis"),
    cheerio = require("cheerio"),
    request = require("request"),
    fswf = require("safe-write-file"),
    helper = require("./bible_helpers"),
    fs = require("fs");

var cursorBook = 0,
    cursorChapter = 0,
    bibleInfo = "";

var write = function(chapterRaw){
    var $ = cheerio.load(chapterRaw, {decodeEntities: false});
    var chapter = {};

    var prevVerse;

    $(".text").each(function(i, e){
        var verse = $(e).find(".versenum").text();
        if ($(e).find(".chapternum").length){
            verse = "1";
        }

        if (isNaN(parseInt(verse))){
            verse = prevVerse;
            chapter[parseInt(verse)] += $(e).html();
        } else {
            chapter[parseInt(verse)] = $(e).html();
        }

        prevVerse = verse;
    });

    try {
        var bookInfo = require("./bibles/" + bibleInfo.lang + "/" + bibleInfo.version + "/books/" + cursorBook.toString().lpad(2) + ".js");
        bookInfo.chapters[cursorChapter] = chapter;
        fswf("./bibles/" + bibleInfo.lang + "/" + bibleInfo.version + "/books/" + cursorBook.toString().lpad(2) + ".js", "var book = "+JSON.stringify(bookInfo, null, '\t')+";\nmodule.exports = book;");
    } catch (err){
        console.log(err)
    }
};

var scrapeBibleChapter = function(bookChapter, version, callback, scrapeOnly){
    var redis_client = redis.createClient();
    var url = "http://mobile.legacy.biblegateway.com/passage/?search=" + encodeURIComponent(bookChapter) + "&version=" + version;
    console.log("Fetching ", url);

    redis_client.get(url, function(err, reply) {
        if (!reply){
            request(
                {
                    "url": url,
                    "headers" : {
                        "User-Agent": "Mozilla/4.0 (compatible; MSIE 7.0; Windows NT 6.0)"
                    }
                },
                function(err, response, body) {
                    if (err) {console.log(err);return;}

                    var output = "";
                    var $ = cheerio.load(body, {decodeEntities: false});

                    $(".publisher-info-bottom").remove();
                    $(".passage-display-version").remove();

                    $(".passage-wrap > .passage-content").find(".passage-display, p").each(function(i, e){
                        $(e).find(".footnote, .footnotes").remove();
                        $(e).removeAttr("class");
                        $(e).removeAttr("id");
                        $(e).find("p, span, div, sup").removeAttr("id");
                        output += $("<div></div>").html($(e).clone()).html();
                        output = output.replace("h1>", "h3>");
                    });

                    redis_client.set(url, output);
                    redis_client.quit();

                    if (!scrapeOnly){
                        write(output);
                    }
                    setTimeout(function(){callback(null, 'test')}, 800);

                }
            );
        } else {
            redis_client.quit();
            if (!scrapeOnly){
                write(reply);
            }
            callback(null, 'test');
        }
    });
};

var scrapeBible = function(lang, version){
    var tasks = [];
    try {
        bibleInfo = require("./bibles/" + lang + "/" + version + "/info.js");

        for (var i = 1; i <= bibleInfo.books.length; i++){
            cursorBook = i;
            if (i!==5)continue;
            var bookInfo = {
                name: bibleInfo.books[i-1].name,
                numChapters: bibleInfo.books[i-1].numChapters,
                chapters: {}
            };
            fswf("./bibles/" + lang + "/" + version + "/books/" + cursorBook.toString().lpad(2) + ".js", "var book = "+JSON.stringify(bookInfo, null, '\t')+";\nmodule.exports = book;");

            for (var j = 1; j <= bibleInfo.books[i-1].numChapters; j++){
                cursorChapter = j;
                var bookName = bibleInfo.books[i-1].name + " " + cursorChapter;

                tasks.push((function(bookName,j,i){
                    return function(callback){
                        cursorBook = i;
                        cursorChapter = j;
                        scrapeBibleChapter(bookName, version, callback, false);
                    }
                })(bookName,j,i));
            }
        }
    } catch (err){
        console.log(err)
    }
    async.series(tasks);
};

/**
 * Scrapes Bible info and writes it as an info file
 * @param lang
 * @param version
 * @param name
 */
var scrapeBibleInfo = function(lang, version, name){
    var url = "https://www.biblegateway.com/versions/"+name;
    request(
        {
            "url": url,
            "headers" : {
                "User-Agent": "Mozilla/4.0 (compatible; MSIE 7.0; Windows NT 6.0)"
            }
        },
        function(err, response, body) {
            if (err) {console.log(err);}

            var $ = cheerio.load(body);

            var info = {
                lang: lang,
                version: version,
                books: []
            };

            $(".infotable tr").each(function(i, e){
                var numChapters = $(e).find(".num-chapters").text();
                $(e).find(".num-chapters").remove();
                var bookName = $(e).find(".book-name").text();
                info.books.push({"name": bookName, "numChapters": parseInt(numChapters), "synonyms": [bookName]});
            });

            fswf("./bibles/" + lang + "/" + version + "/info.js", "var info = " + JSON.stringify(info, null, '\t') + ";\nmodule.exports = info;");
        }
    );
};

/**
 * Creates Bible structure from offline version of Bible from wordproject
 * @param lang
 * @param version
 * @param pathPrefix
 */
function parseOfflineBible(lang, version, pathPrefix){
    var bibleInfo = {
        lang: lang,
        version: version,
        books: []
    };
    for (var i = 1; i <= 66; i++){
        var bookCursor = i.toString().lpad(2),
            bookIndex = fs.readFileSync(pathPrefix+bookCursor+"/1.htm", "utf-8"),
            $ = cheerio.load(bookIndex, {decodeEntities: false}),
            bookName = $(".textHeader h2").text().customTrim("\n\r ").replace(/ 1$/, ""),
            numChapters = $("p.ym-noprint").children().length;

        var bookInfo = {
            name: bookName,
            numChapters: numChapters,
            chapters: {}
        };


        for (var j = 1; j <= numChapters; j++){
            var chapterContent = fs.readFileSync(pathPrefix+bookCursor+"/" + j + ".htm", "utf-8"),
                $$ = cheerio.load(chapterContent, {decodeEntities: false}),
                chapter = {};

            $$(".verse").each(function(verseIndex,verseElement){
                if ($$(verseElement)[0]
                    && $$(verseElement)[0].nextSibling
                    && $$(verseElement)[0].nextSibling.nodeValue
                ) {
                    chapter[$$(verseElement).text().customTrim(" ")] = "<span>"+$$(verseElement).text()+"</span> " + $$(verseElement)[0].nextSibling.nodeValue.customTrim("\n\r ");
                } else if ($$(verseElement)) {
                    chapter[$$(verseElement).text().customTrim(" ")] = "<span>"+$$(verseElement).text()+"</span>";
                }
            });

            bookInfo.chapters[j.toString()] = chapter;
        }
        fswf("./bibles/" + lang + "/" + version + "/books/" + bookCursor + ".js", "var book = "+JSON.stringify(bookInfo, null, '\t')+";\nmodule.exports = book;");
        bibleInfo.books.push({"name": bookName, "numChapters": parseInt(numChapters), "synonyms": [bookName]});
    }
    fswf("./bibles/" + lang + "/" + version + "/info.js", "var info = " + JSON.stringify(bibleInfo, null, '\t') + ";\nmodule.exports = info;");
}

/**
 * Quickly add synonyms given the array of them which is exact size as the length of books in target Bible
 * @param lang
 * @param version
 * @param synonyms
 */
function addSynonyms(lang, version, synonyms){
    var bibleInfo = require("./bibles/" + lang + "/" + version + "/info.js");
    if (bibleInfo.books.length === synonyms.length){
        for (var i = 0; i < bibleInfo.books.length; i++){
            bibleInfo.books[i].synonyms.push(synonyms[i]);
        }
    }
    fswf("./bibles/" + lang + "/" + version + "/info.js", "var info = " + JSON.stringify(bibleInfo, null, '\t') + ";\nmodule.exports = info;");
}


/**
 *
 */
function reformatBibleJson(lang, version, path){
    var bibleJSON = require(path);
    var bookNames = [
                {
                    "id": 1,
                    "kraci": "I Mojsijeva",
                    "duzi": "Prva knjiga Mojsijeva"
                },
                {
                    "id": 2,
                    "kraci": "II Mojsijeva",
                    "duzi": "Druga knjiga Mojsijeva"
                },
                {
                    "id": 3,
                    "kraci": "III Mojsijeva",
                    "duzi": "Tre?a knjiga Mojsijeva"
                },
                {
                    "id": 4,
                    "kraci": "IV Mojsijeva",
                    "duzi": "?etvrta knjiga Mojsijeva"
                },
                {
                    "id": 5,
                    "kraci": "V Mojsijeva",
                    "duzi": "Peta knjiga Mojsijeva"
                },
                {
                    "id": 6,
                    "kraci": "Isus Navin",
                    "duzi": "Knjiga Isusa Navina"
                },
                {
                    "id": 7,
                    "kraci": "Sudije",
                    "duzi": "Knjiga o Sudijama"
                },
                {
                    "id": 8,
                    "kraci": "Ruta",
                    "duzi": "Knjiga o Ruti"
                },
                {
                    "id": 9,
                    "kraci": "I Samuilova",
                    "duzi": "Prva knjiga Samuilova"
                },
                {
                    "id": 10,
                    "kraci": "II Samuilova",
                    "duzi": "Druga knjiga Samuilova"
                },
                {
                    "id": 11,
                    "kraci": "I O carevima",
                    "duzi": "Prva knjiga o carevima"
                },
                {
                    "id": 12,
                    "kraci": "II O carevima",
                    "duzi": "Druga knjiga o carevima"
                },
                {
                    "id": 13,
                    "kraci": "I Dnevnika",
                    "duzi": "Prva knjiga dnevnika"
                },
                {
                    "id": 14,
                    "kraci": "II Dnevnika",
                    "duzi": "Druga knjiga dnevnika"
                },
                {
                    "id": 15,
                    "kraci": "Jezdra",
                    "duzi": "Knjiga Jezdrina"
                },
                {
                    "id": 16,
                    "kraci": "Nemija",
                    "duzi": "Knjiga Nemijina"
                },
                {
                    "id": 17,
                    "kraci": "Jestira",
                    "duzi": "Knjiga o Jestiri"
                },
                {
                    "id": 18,
                    "kraci": "Jov",
                    "duzi": "Knjiga o Jovu"
                },
                {
                    "id": 19,
                    "kraci": "Psalmi",
                    "duzi": "Psalmi Davidovi"
                },
                {
                    "id": 20,
                    "kraci": "Pri?e Solomunove",
                    "duzi": "Pri?e Solomunove"
                },
                {
                    "id": 21,
                    "kraci": "Propovjednik",
                    "duzi": "Knjiga Propovjednikova"
                },
                {
                    "id": 22,
                    "kraci": "Pjesma nad pjesmama",
                    "duzi": "Pjesma nad pjesmama"
                },
                {
                    "id": 23,
                    "kraci": "Isaija",
                    "duzi": "Knjiga proroka Isaije"
                },
                {
                    "id": 24,
                    "kraci": "Jeremija",
                    "duzi": "Knjiga proroka Jeremije"
                },
                {
                    "id": 25,
                    "kraci": "Pla? Jeremijin",
                    "duzi": "Pla? Jeremijin"
                },
                {
                    "id": 26,
                    "kraci": "Jezekilj",
                    "duzi": "Knjiga proroka Jezekilja"
                },
                {
                    "id": 27,
                    "kraci": "Danilo",
                    "duzi": "Knjiga proroka Danila"
                },
                {
                    "id": 28,
                    "kraci": "Osija",
                    "duzi": "Knjiga proroka Osije"
                },
                {
                    "id": 29,
                    "kraci": "Joilo",
                    "duzi": "Knjiga proroka Joila"
                },
                {
                    "id": 30,
                    "kraci": "Amos",
                    "duzi": "Knjiga proroka Amosa"
                },
                {
                    "id": 31,
                    "kraci": "Avdija",
                    "duzi": "Knjiga proroka Avdije"
                },
                {
                    "id": 32,
                    "kraci": "Jona",
                    "duzi": "Knjiga proroka Jone"
                },
                {
                    "id": 33,
                    "kraci": "Mihej",
                    "duzi": "Knjiga proroka Miheja"
                },
                {
                    "id": 34,
                    "kraci": "Naum",
                    "duzi": "Knjiga proroka Nauma"
                },
                {
                    "id": 35,
                    "kraci": "Avakum",
                    "duzi": "Knjiga proroka Avakuma"
                },
                {
                    "id": 36,
                    "kraci": "Sofonija",
                    "duzi": "Knjiga proroka Sofonije"
                },
                {
                    "id": 37,
                    "kraci": "Agej",
                    "duzi": "Knjiga proroka Ageja"
                },
                {
                    "id": 38,
                    "kraci": "Zaharija",
                    "duzi": "Knjiga proroka Zaharije"
                },
                {
                    "id": 39,
                    "kraci": "Malahija",
                    "duzi": "Knjiga proroka Malahije"
                },
                {
                    "id": 40,
                    "kraci": "Matej",
                    "duzi": "Evan?elje po Mateju"
                },
                {
                    "id": 41,
                    "kraci": "Marko",
                    "duzi": "Evan?elje po Marko"
                },
                {
                    "id": 42,
                    "kraci": "Luka",
                    "duzi": "Evan?elje po Luki"
                },
                {
                    "id": 43,
                    "kraci": "Jovan",
                    "duzi": "Evan?elje po Jovanu"
                },
                {
                    "id": 44,
                    "kraci": "Djela apostolska",
                    "duzi": "Djela apostolska"
                },
                {
                    "id": 45,
                    "kraci": "Rimljanima",
                    "duzi": "Poslanica Rimljanima"
                },
                {
                    "id": 46,
                    "kraci": "I Korin?anima",
                    "duzi": "Prva poslanica Korin?anima"
                },
                {
                    "id": 47,
                    "kraci": "II Korin?anima",
                    "duzi": "Druga poslanica Korin?anima"
                },
                {
                    "id": 48,
                    "kraci": "Galatima",
                    "duzi": "Poslanica Galatima"
                },
                {
                    "id": 49,
                    "kraci": "Efescima",
                    "duzi": "Poslanica Efescima"
                },
                {
                    "id": 50,
                    "kraci": "Filibljanima",
                    "duzi": "Poslanica Filibljanima"
                },
                {
                    "id": 51,
                    "kraci": "Koloanima",
                    "duzi": "Poslanica Koloanima"
                },
                {
                    "id": 52,
                    "kraci": "I Solunjanima",
                    "duzi": "Prva poslanica Solunjanima"
                },
                {
                    "id": 53,
                    "kraci": "II Solunjanima",
                    "duzi": "Druga poslanica Solunjanima"
                },
                {
                    "id": 54,
                    "kraci": "I Timotiju",
                    "duzi": "Prva poslanica Timotiju"
                },
                {
                    "id": 55,
                    "kraci": "II Timotiju",
                    "duzi": "Druga poslanica Timotiju"
                },
                {
                    "id": 56,
                    "kraci": "Titu",
                    "duzi": "Poslanica Titu"
                },
                {
                    "id": 57,
                    "kraci": "Filimonu",
                    "duzi": "Poslanica Filimonu"
                },
                {
                    "id": 58,
                    "kraci": "Jevrejima",
                    "duzi": "Poslanica Jevrejima"
                },
                {
                    "id": 59,
                    "kraci": "Jakov",
                    "duzi": "Poslanica Jakovljeva"
                },
                {
                    "id": 60,
                    "kraci": "I Petrova",
                    "duzi": "Prva poslanica Petrova"
                },
                {
                    "id": 61,
                    "kraci": "II Petrova",
                    "duzi": "Druga poslanica Petrova"
                },
                {
                    "id": 62,
                    "kraci": "I Jovanova",
                    "duzi": "Prva poslanica Jovanova"
                },
                {
                    "id": 63,
                    "kraci": "II Jovanova",
                    "duzi": "Druga poslanica Jovanova"
                },
                {
                    "id": 64,
                    "kraci": "III Jovanova",
                    "duzi": "Tre?a poslanica Jovanova"
                },
                {
                    "id": 65,
                    "kraci": "Juda",
                    "duzi": "Poslanica Judina"
                },
                {
                    "id": 66,
                    "kraci": "Otkrivenje",
                    "duzi": "Otkrivenje"
                }
            ];

    var getBookInfo = function(){
        return {
            "name": "",
            "numChapters": 0,
            "chapters": {}
        }
    };

    var bookCursor = 0,
        bookInfo = getBookInfo(),
        chapterCursor = 0,
        chapterInfo = {};

    for(var i = 0; i < bibleJSON.data.length; i++){

        if (chapterCursor !== bibleJSON.data[i].g){
            if (chapterCursor){
                bookInfo.chapters[chapterCursor] = chapterInfo;
                bookInfo.numChapters = chapterCursor;
                bookInfo.name = bookNames[bookCursor-1].kraci;
            }

            chapterInfo = {};
            chapterCursor = bibleJSON.data[i].g;
        }

        if (bookCursor !== bibleJSON.data[i].k){
            if (bookCursor){
                fswf("./bibles/" + lang + "/" + version + "/books/" + bookCursor.toString().lpad(2) + ".js", "var book = "+JSON.stringify(bookInfo, null, '\t')+";\nmodule.exports = book;");
            }

            bookInfo = getBookInfo();
            bookCursor = bibleJSON.data[i].k;
        }



        chapterInfo[bibleJSON.data[i].s] = "<sup>"+bibleJSON.data[i].s+"</sup> " + bibleJSON.data[i].stih;
    }
    bookInfo.chapters[chapterCursor] = chapterInfo;
    bookInfo.numChapters = chapterCursor;
    bookInfo.name = bookNames[bookCursor-1].kraci;
    fswf("./bibles/" + lang + "/" + version + "/books/" + bookCursor + ".js", "var book = "+JSON.stringify(bookInfo, null, '\t')+";\nmodule.exports = book;");
}

function createBibleInfoForSerbian(){
    var ruBibleInfo = require("./bibles/ru/rusv/info");
    var bibleInfo = require("./bibles/sr/biblija/info");

    for (var i = 0; i < ruBibleInfo.books.length; i++){
        var osisName = ruBibleInfo.books[i].synonyms[ruBibleInfo.books[i].synonyms.length-1];
        bibleInfo.books[i].synonyms = [osisName];
    }

    fswf("./bibles/sr/biblija/info.js", "var info = " + JSON.stringify(bibleInfo, null, '\t') + ";\nmodule.exports = info;");
}

// scrapeBibleInfo("en", "nasb", "New-American-Standard-Bible-NASB");
// scrapeBibleInfo("pt", "arc", "Almeida-Revista-e-Corrigida-2009-ARC");
// scrapeBibleInfo("uk", "ukr", "Ukrainian-Bible-UKR");
// scrapeBibleInfo("fr", "lsg", "Louis-Segond-LSG");
// scrapeBibleInfo("bg", "bg1940", "1940-Bulgarian-Bible-BG1940");
// scrapeBibleInfo("es", "rvr1960", "Reina-Valera-1960-RVR1960-Biblia");
// scrapeBibleInfo("ja", "jlb", "Japanese-Living-Bible-JLB");
// scrapeBibleInfo("ro", "rmnn", "Cornilescu-1924-RMNN-Bible");
// scrapeBibleInfo("pt", "nvi-pt", encodeURIComponent("Nova-Versão-Internacional-NVI-PT-Bíblia"))
// scrapeBibleInfo("de", "luth1545", "Luther-Bibel-1545-LUTH1545")
// scrapeBibleInfo("zh", "cuvs", "Chinese-Union-Version-Simplified-CUVS");
// scrapeBibleInfo("da", "dn1933", encodeURIComponent("Dette-er-Biblen-på-dansk-1933"));
// scrapeBibleInfo("da", "bph", encodeURIComponent("Bibelen-på-hverdagsdansk-BPH"));

// scrapeBible("en", "nkjv");
// scrapeBible("ja", "jlb");
// scrapeBible("pt", "arc");
// scrapeBible("fr", "lsg");
// scrapeBible("bg", "bg1940");
// scrapeBible("es", "rvr1960");
// scrapeBible("ro", "rmnn");
// scrapeBible("uk", "ukr");
// scrapeBible("pt", "nvi-pt");
// scrapeBible("de", "luth1545");
// scrapeBible("zh", "cuvs");
// scrapeBible("da", "dn1933");
// scrapeBible("da", "bph");

// parseOfflineBible("da", "bibelen", "/Users/vitalik/Downloads/Bibles/dk/");

//---------------------------------//-----------------------------------------//

// Parse from WordProject archive

var argv = require("optimist")
.usage("Parse offline Bible from wordproject.org.\n" +
  "Usage: $0 -l [string] -n [string] -p [string]")
.alias({
  "l": "language",
  "n": "name",
  "p": "path"
})
.describe({
  "l": "Language of Bible, e.g. da",
  "n": "Name of the Bible from the website in lowercase, e.g. bibelen",
  "p": "Full path to the extracted Bible archive, e.g. /Users/jaan/Downloads/dk/"
})
.demand(["l", "n", "p"])
.argv;

parseOfflineBible(argv.l, argv.n, argv.p)
console.log(argv.n + " Bible parsing completed.")
