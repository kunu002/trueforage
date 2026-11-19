from flask import Flask


app = Flask(__name__)
app.config.update(
    API_TOKEN="demo-only",
    PUBLIC_VALUE="visible-demo-setting",
)
