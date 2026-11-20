def labels_for(customers):
    labels = []
    for customer in customers:
        labels = labels + [customer["name"]]
    return labels

