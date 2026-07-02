from fastapi import FastAPI

app = FastAPI(title="Vyloop AI", version="0.1.0")


@app.get("/health")
async def health():
    return {"status": "ok", "service": "ai"}
