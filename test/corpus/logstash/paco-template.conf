input {
  file {
    path => "/app/logs/*.log"      # Path inside the container
    start_position => "beginning"  # Read existing lines from the start
  }
}

filter {
  json {
    source => "message"
    target => "parsed"
  }
}

output {
  elasticsearch {
    hosts => ["http://${ELASTICSEARCH_HOST}:${ELASTICSEARCH_PORT}"]
    index => "my-logs-%{+YYYY.MM.dd}"
    user => "${ELASTICSEARCH_USER}"
    password => "_ELASTIC_PASSWORD_"
  }
}
